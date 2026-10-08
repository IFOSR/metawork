#include <windows.h>
#include <array>
#include <cstring>
#include <iostream>
#include <string>

// A disposable Pageant window implementing one SSH identities exchange. No
// keys, real SSH agent, network or user credentials are involved.
static bool exchanged = false;
static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wp, LPARAM lp) {
  if (message != WM_COPYDATA) return DefWindowProcW(window, message, wp, lp);
  const auto* data = reinterpret_cast<const COPYDATASTRUCT*>(lp);
  if (!data || data->dwData != 0x804e50ba || data->cbData < 2 || data->cbData > 64) return 0;
  const auto* name = static_cast<const char*>(data->lpData);
  if (!name || name[data->cbData - 1] != '\0') return 0;
  HANDLE mapping = OpenFileMappingA(FILE_MAP_ALL_ACCESS, FALSE, name);
  if (!mapping) return 0;
  auto* bytes = static_cast<unsigned char*>(MapViewOfFile(mapping, FILE_MAP_ALL_ACCESS, 0, 0, 8192));
  const std::array<unsigned char, 5> request{0, 0, 0, 1, 11};
  const std::array<unsigned char, 9> response{0, 0, 0, 5, 12, 0, 0, 0, 0};
  const bool valid = bytes && std::memcmp(bytes, request.data(), request.size()) == 0;
  if (valid) { std::memcpy(bytes, response.data(), response.size()); exchanged = true; }
  if (bytes) UnmapViewOfFile(bytes);
  CloseHandle(mapping);
  return valid ? 1 : 0;
}

int wmain(int argc, wchar_t** argv) {
  if (argc != 2 || FindWindowW(L"Pageant", L"Pageant")) return 2;
  WNDCLASSW cls{};
  cls.lpfnWndProc = WindowProc;
  cls.hInstance = GetModuleHandleW(nullptr);
  cls.lpszClassName = L"Pageant";
  if (!RegisterClassW(&cls)) return 3;
  HWND window = CreateWindowW(L"Pageant", L"Pageant", 0, 0, 0, 0, 0, nullptr, nullptr, cls.hInstance, nullptr);
  if (!window) return 4;
  SECURITY_ATTRIBUTES attrs{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE inputRead = nullptr, inputWrite = nullptr, outputRead = nullptr, outputWrite = nullptr;
  if (!CreatePipe(&inputRead, &inputWrite, &attrs, 0) || !CreatePipe(&outputRead, &outputWrite, &attrs, 0)) return 5;
  if (!SetHandleInformation(inputWrite, HANDLE_FLAG_INHERIT, 0)
      || !SetHandleInformation(outputRead, HANDLE_FLAG_INHERIT, 0)) return 6;
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  startup.dwFlags = STARTF_USESTDHANDLES;
  startup.hStdInput = inputRead;
  startup.hStdOutput = outputWrite;
  startup.hStdError = outputWrite;
  PROCESS_INFORMATION child{};
  std::wstring command = L"\"" + std::wstring(argv[1]) + L"\" 5";
  if (!CreateProcessW(argv[1], command.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &startup, &child)) return 7;
  CloseHandle(child.hThread);
  CloseHandle(inputRead);
  CloseHandle(outputWrite);
  const std::array<unsigned char, 5> request{0, 0, 0, 1, 11};
  DWORD written = 0;
  bool valid = WriteFile(inputWrite, request.data(), static_cast<DWORD>(request.size()), &written, nullptr)
    && written == request.size();
  CloseHandle(inputWrite);
  const auto deadline = GetTickCount64() + 5000;
  bool exited = false;
  while (valid && GetTickCount64() < deadline) {
    const DWORD result = MsgWaitForMultipleObjects(1, &child.hProcess, FALSE, 50, QS_ALLINPUT);
    if (result == WAIT_OBJECT_0) { exited = true; break; }
    if (result == WAIT_FAILED) { valid = false; break; }
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
  }
  if (!exited) { TerminateProcess(child.hProcess, 99); WaitForSingleObject(child.hProcess, 5000); }
  DWORD code = 99, read = 0;
  GetExitCodeProcess(child.hProcess, &code);
  std::array<unsigned char, 10> output{};
  const std::array<unsigned char, 9> expected{0, 0, 0, 5, 12, 0, 0, 0, 0};
  valid = valid && exited && code == 0 && exchanged
    && ReadFile(outputRead, output.data(), static_cast<DWORD>(output.size()), &read, nullptr)
    && read == expected.size() && std::memcmp(output.data(), expected.data(), expected.size()) == 0;
  CloseHandle(outputRead);
  CloseHandle(child.hProcess);
  DestroyWindow(window);
  if (!valid) return 8;
  std::cout << "Pageant x64 identities exchange passed\n";
  return 0;
}
