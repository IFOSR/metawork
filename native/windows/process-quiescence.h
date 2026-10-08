// Documented thread APIs only; controller owns one Job, never arbitrary PIDs.
#pragma once
#include <tlhelp32.h>
#include <map>
#include <set>

namespace windows_process {
std::set<DWORD> members(HANDLE job) {
  std::vector<BYTE> bytes(sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 65536);
  auto list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(bytes.data());
  require(QueryInformationJobObject(job, JobObjectBasicProcessIdList, list,
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
      Handle snapshot(CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0));
      require(snapshot.get() != INVALID_HANDLE_VALUE, "thread snapshot");
      THREADENTRY32 entry{}; entry.dwSize = sizeof(entry);
      bool added = false;
      if (Thread32First(snapshot.get(), &entry)) do {
        if (!pids.count(entry.th32OwnerProcessID) || threads_.count(entry.th32ThreadID)) continue;
        Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32OwnerProcessID));
        if (!process.get()) {
          require(GetLastError() == ERROR_INVALID_PARAMETER, "open live job process");
          continue;
        }
        BOOL contained = FALSE;
        require(IsProcessInJob(process.get(), job_, &contained) != FALSE && contained, "owned job process");
        auto thread = std::make_unique<Handle>(OpenThread(SYNCHRONIZE | THREAD_SUSPEND_RESUME | THREAD_QUERY_LIMITED_INFORMATION | THREAD_GET_CONTEXT,
          FALSE, entry.th32ThreadID));
        if (!thread->get()) {
          require(GetLastError() == ERROR_INVALID_PARAMETER, "open live job thread");
          continue;
        }
        require(GetProcessIdOfThread(thread->get()) == entry.th32OwnerProcessID, "thread process identity");
        const DWORD previous = SuspendThread(thread->get());
        if (previous == static_cast<DWORD>(-1)) {
          const DWORD error = GetLastError();
          // A terminating thread can reject suspension before its exit code
          // becomes visible. Require the retained object to signal; never
          // interpret ACCESS_DENIED alone as proof that a thread has exited.
          if (WaitForSingleObject(thread->get(), 100) != WAIT_OBJECT_0) {
            SetLastError(error); require(false, "suspend live thread");
          }
          continue;
        }
        threads_.emplace(entry.th32ThreadID, std::move(thread));
        // SuspendThread requests suspension; obtain context to wait until the
        // target has actually stopped executing user-mode instructions.
        CONTEXT context{}; context.ContextFlags = CONTEXT_CONTROL;
        if (!GetThreadContext(threads_.at(entry.th32ThreadID)->get(), &context)) {
          const DWORD error = GetLastError();
          if (WaitForSingleObject(threads_.at(entry.th32ThreadID)->get(), 100) != WAIT_OBJECT_0) {
            SetLastError(error); require(false, "suspended thread context");
          }
        }
        added = true;
      } while (Thread32Next(snapshot.get(), &entry));
      if (!added && members(job_) == pids) return;
      Sleep(1);
    }
    throw std::runtime_error("Job did not reach thread quiescence");
  }
  size_t size() const { return threads_.size(); }
  void resume(bool strict = true) {
    bool failed = false;
    for (auto& entry : threads_) {
      if (ResumeThread(entry.second->get()) == static_cast<DWORD>(-1)) {
        if (WaitForSingleObject(entry.second->get(), 100) != WAIT_OBJECT_0) failed = true;
      }
    }
    threads_.clear();
    if (strict) require(!failed, "resume owned threads");
  }
 private:
  HANDLE job_;
  std::map<DWORD, std::unique_ptr<Handle>> threads_;
};

}
