// P0 only: documented Job Object and thread APIs, no task or permission policy.
#include <windows.h>
#include <tlhelp32.h>
#include <algorithm>
#include <cstdint>
#include <filesystem>
#include <map>
#include <set>
#include <string>
#include <vector>
#include <thread>
#include <memory>
#include <iostream>
#include <stdexcept>

void check(bool ok, const char* message) {
  if (!ok) throw std::runtime_error(std::string(message) + ": " + std::to_string(GetLastError()));
}
struct OwnedHandle {
  HANDLE value;
  explicit OwnedHandle(HANDLE handle) : value(handle) {}
  ~OwnedHandle() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); }
  OwnedHandle(const OwnedHandle&) = delete;
  OwnedHandle& operator=(const OwnedHandle&) = delete;
};
std::wstring executable() {
  std::vector<wchar_t> buffer(32768);
  const DWORD count = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
  check(count > 0 && count < buffer.size(), "module path");
  return std::wstring(buffer.data(), count);
}
std::wstring arguments(const std::wstring& mode, const std::wstring& root) {
  check(root.find(L'"') == std::wstring::npos, "fixture path");
  return L"\"" + executable() + L"\" " + mode + L" \"" + root + L"\"";
}
void worker(const std::wstring& root, bool children) {
  if (children) {
    for (unsigned int index = 0; index < 2; index++) {
      auto command = arguments(L"leaf", root);
      STARTUPINFOW startup{}; startup.cb = sizeof(startup);
      PROCESS_INFORMATION process{};
      check(CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW,
        nullptr, root.c_str(), &startup, &process) != FALSE, "child worker");
      CloseHandle(process.hThread); CloseHandle(process.hProcess);
    }
  }
  const auto file_path = root + L"\\" + std::to_wstring(GetCurrentProcessId()) + L".tick";
  OwnedHandle file(CreateFileW(file_path.c_str(), FILE_APPEND_DATA,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
  check(file.value != INVALID_HANDLE_VALUE, "worker heartbeat file");
  for (;;) {
    // Continually create threads to exercise suspension during thread churn.
    std::thread thread([&]() {
      DWORD written = 0;
      const char tick = '.';
      WriteFile(file.value, &tick, 1, &written, nullptr);
      FlushFileBuffers(file.value);
    });
    thread.join(); Sleep(10);
  }
}

std::set<DWORD> members(HANDLE job) {
  std::vector<BYTE> bytes(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 64);
  auto list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(bytes.data());
  check(QueryInformationJobObject(job, JobObjectBasicProcessIdList, list,
    static_cast<DWORD>(bytes.size()), nullptr) != FALSE, "job process list");
  std::set<DWORD> result;
  for (DWORD index = 0; index < list->NumberOfProcessIdsInList; index++)
    result.insert(static_cast<DWORD>(list->ProcessIdList[index]));
  return result;
}

class SuspendedThreads {
 public:
  explicit SuspendedThreads(HANDLE job) : job_(job) {}
  ~SuspendedThreads() { resume(false); }
  void pause() {
    if (!threads_.empty()) return;
    for (unsigned int pass = 0; pass < 128; pass++) {
      const auto pids = members(job_);
      OwnedHandle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0));
      check(snapshot.value != INVALID_HANDLE_VALUE, "thread snapshot");
      THREADENTRY32 entry{}; entry.dwSize = sizeof(entry);
      bool added = false;
      if (Thread32First(snapshot.value, &entry)) do {
        if (!pids.count(entry.th32OwnerProcessID) || threads_.count(entry.th32ThreadID)) continue;
        OwnedHandle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32OwnerProcessID));
        if (!process.value) continue;
        BOOL contained = FALSE;
        check(IsProcessInJob(process.value, job_, &contained) != FALSE && contained, "owned job process");
        auto thread = std::make_unique<OwnedHandle>(OpenThread(THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION,
          FALSE, entry.th32ThreadID));
        if (!thread->value) continue;
        check(GetProcessIdOfThread(thread->value) == entry.th32OwnerProcessID, "thread process identity");
        const DWORD previous = SuspendThread(thread->value);
        if (previous == static_cast<DWORD>(-1)) {
          DWORD code = STILL_ACTIVE;
          check(GetExitCodeThread(thread->value, &code) != FALSE && code != STILL_ACTIVE, "suspend live thread");
          continue;
        }
        threads_.emplace(entry.th32ThreadID, std::move(thread));
        added = true;
      } while (Thread32Next(snapshot.value, &entry));
      if (!added && members(job_) == pids && !threads_.empty()) return;
      Sleep(1);
    }
    throw std::runtime_error("Job did not reach thread quiescence");
  }
  size_t size() const { return threads_.size(); }
  void resume(bool strict = true) {
    bool failed = false;
    for (auto& entry : threads_) {
      if (ResumeThread(entry.second->value) == static_cast<DWORD>(-1)) {
        DWORD code = STILL_ACTIVE;
        if (!GetExitCodeThread(entry.second->value, &code) || code == STILL_ACTIVE) failed = true;
      }
    }
    threads_.clear();
    if (strict) check(!failed, "resume owned threads");
  }
 private:
  HANDLE job_;
  std::map<DWORD, std::unique_ptr<OwnedHandle>> threads_;
};

std::map<std::wstring, uintmax_t> heartbeats(const std::wstring& root) {
  std::map<std::wstring, uintmax_t> values;
  for (const auto& entry : std::filesystem::directory_iterator(root)) {
    if (entry.path().extension() == L".tick") values.emplace(entry.path().filename().wstring(), entry.file_size());
  }
  return values;
}

void probe(const std::wstring& root) {
  OwnedHandle job(CreateJobObjectW(nullptr, nullptr));
  check(job.value != nullptr, "create job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
  limits.BasicLimitInformation.ActiveProcessLimit = 16;
  check(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE,
    "set job ownership limits");
  auto command = arguments(L"worker", root);
  STARTUPINFOW startup{}; startup.cb = sizeof(startup);
  PROCESS_INFORMATION child{};
  check(CreateProcessW(nullptr, command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW,
    nullptr, root.c_str(), &startup, &child) != FALSE, "create suspended root");
  OwnedHandle process(child.hProcess), thread(child.hThread);
  if (!AssignProcessToJobObject(job.value, process.value)) {
    TerminateProcess(process.value, 1);
    throw std::runtime_error("Could not assign root to job before execution");
  }
  check(ResumeThread(thread.value) != static_cast<DWORD>(-1), "start owned root");
  for (unsigned int wait = 0; heartbeats(root).size() < 3 && wait < 100; wait++) Sleep(50);
  const auto initial = heartbeats(root);
  const auto initial_members = members(job.value);
  if (initial.size() != 3) throw std::runtime_error("Expected three heartbeat workers, got " + std::to_string(initial.size()));
  for (const auto& item : initial) {
    const DWORD pid = static_cast<DWORD>(std::stoul(item.first));
    if (!initial_members.count(pid)) throw std::runtime_error("Heartbeat worker " + std::to_string(pid)
      + " is not in owned job; members=" + std::to_string(initial_members.size()));
  }
  size_t suspended = 0;
  {
    SuspendedThreads paused(job.value);
    for (unsigned int attempt = 0; attempt < 10; attempt++) {
      paused.pause(); paused.pause();
      suspended = (std::max)(suspended, paused.size());
      Sleep(50); // Allow already-issued kernel file writes to settle.
      const auto before = heartbeats(root);
      Sleep(150);
      check(heartbeats(root) == before, "all worker activity remains paused");
      paused.resume(); paused.resume();
      bool advanced = false;
      for (unsigned int wait = 0; wait < 100; wait++) {
        Sleep(20);
        const auto after = heartbeats(root);
        advanced = std::all_of(before.begin(), before.end(), [&](const auto& value) {
          return after.at(value.first) > value.second;
        });
        if (advanced) break;
      }
      if (!advanced) {
        const auto after = heartbeats(root);
        for (const auto& value : before) std::cerr << "worker=" << std::stoul(value.first)
          << " before=" << value.second << " after=" << after.at(value.first) << '\n';
        throw std::runtime_error("Workers did not resume within two seconds");
      }
    }
    paused.pause();
    check(TerminateJobObject(job.value, 0) != FALSE, "cancel whole job while paused");
  }
  for (unsigned int wait = 0; !members(job.value).empty() && wait < 100; wait++) Sleep(20);
  check(members(job.value).empty(), "no residual job process");
  check(WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0, "root exited");
  std::cout << "{\"scope\":\"job-process-spike\",\"passed\":true,\"workers\":3,\"pauseResumeCycles\":10,\"suspendedThreads\":"
    << suspended << ",\"initialJobMembers\":" << initial_members.size()
    << ",\"cancelWhilePaused\":true,\"remainingProcesses\":0,\"p0Accepted\":false}\n";
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc != 3) throw std::runtime_error("Mode and explicit fixture directory required");
    const std::wstring mode(argv[1]);
    if (mode == L"probe") probe(argv[2]);
    else if (mode == L"worker" || mode == L"leaf") worker(argv[2], mode == L"worker");
    else throw std::runtime_error("Unknown process probe mode");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n'; return 1;
  }
}
