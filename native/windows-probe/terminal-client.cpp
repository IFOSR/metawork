// Acceptance-only ConPTY carrier. It owns only the installed CLI/TUI children;
// the independently started product Server is never in this Job.
#include <windows.h>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

struct Handle {
  HANDLE value = nullptr;
  ~Handle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
};
void check(bool ok, const char* label) {
  if (!ok) throw std::runtime_error(std::string(label) + " Win32=" + std::to_string(GetLastError()));
}
std::wstring quote(const std::wstring& value) {
  std::wstring out = L"\"";
  size_t slashes = 0;
  for (wchar_t character : value) {
    if (character == L'\\') { slashes++; continue; }
    out.append(slashes * (character == L'"' ? 2 : 1), L'\\'); slashes = 0;
    if (character == L'"') out += L'\\';
    out += character;
  }
  out.append(slashes * 2, L'\\');
  return out + L'"';
}
void copy(HANDLE from, HANDLE to) {
  char buffer[16384]; DWORD read = 0;
  while (ReadFile(from, buffer, sizeof(buffer), &read, nullptr) && read) {
    DWORD offset = 0;
    while (offset < read) {
      DWORD written = 0;
      if (!WriteFile(to, buffer + offset, read - offset, &written, nullptr) || !written) return;
      offset += written;
    }
  }
}
int wmain(int argc, wchar_t** argv) {
  if (argc < 2) return 2;
  HPCON console = nullptr;
  try {
    Handle inputRead, inputWrite, outputRead, outputWrite, job;
    check(CreatePipe(&inputRead.value, &inputWrite.value, nullptr, 0), "ConPTY input pipe");
    check(CreatePipe(&outputRead.value, &outputWrite.value, nullptr, 0), "ConPTY output pipe");
    std::cerr << "ConPTY: creating console\n";
    check(SUCCEEDED(CreatePseudoConsole({ 140, 45 }, inputRead.value, outputWrite.value, 0, &console)), "ConPTY creation");
    std::cerr << "ConPTY: console ready\n";
    CloseHandle(inputRead.value); inputRead.value = nullptr;
    CloseHandle(outputWrite.value); outputWrite.value = nullptr;
    job.value = CreateJobObjectW(nullptr, nullptr);
    check(job.value != nullptr, "Client Job creation");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)), "Client Job ownership");
    SIZE_T size = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &size);
    std::vector<BYTE> storage(size);
    auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    check(InitializeProcThreadAttributeList(attributes, 1, 0, &size), "Client attributes");
    check(UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, console, sizeof(console), nullptr, nullptr), "Client terminal binding");
    STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup); startup.lpAttributeList = attributes;
    PROCESS_INFORMATION process{};
    std::wstring command;
    for (int i = 1; i < argc; i++) { if (i > 1) command += L' '; command += quote(argv[i]); }
    std::cerr << "ConPTY: creating client\n";
    const bool created = CreateProcessW(argv[1], command.data(), nullptr, nullptr, FALSE,
      EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED, nullptr, nullptr, &startup.StartupInfo, &process) != FALSE;
    DeleteProcThreadAttributeList(attributes);
    check(created, "Installed CLI creation");
    std::cerr << "ConPTY: client created\n";
    Handle child{ process.hProcess }, thread{ process.hThread };
    if (!AssignProcessToJobObject(job.value, child.value)) {
      TerminateProcess(child.value, 2); throw std::runtime_error("Client Job assignment");
    }
    check(ResumeThread(thread.value) != static_cast<DWORD>(-1), "Installed CLI resume");
    std::cerr << "ConPTY: client resumed\n";
    std::thread output([&] { copy(outputRead.value, GetStdHandle(STD_OUTPUT_HANDLE)); });
    std::thread input([&] {
      copy(GetStdHandle(STD_INPUT_HANDLE), inputWrite.value);
      TerminateJobObject(job.value, 1); // Harness disconnect; only this client tree.
    });
    WaitForSingleObject(child.value, INFINITE);
    DWORD code = 2; GetExitCodeProcess(child.value, &code);
    std::cerr << "ConPTY: client exited " << code << '\n';
    CancelSynchronousIo(input.native_handle()); input.join();
    std::cerr << "ConPTY: input closed\n";
    ClosePseudoConsole(console); console = nullptr;
    std::cerr << "ConPTY: console closed\n";
    output.join();
    return static_cast<int>(code);
  } catch (const std::exception& error) {
    if (console) ClosePseudoConsole(console);
    std::cerr << error.what() << '\n'; return 2;
  }
}
