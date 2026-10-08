// Owned process lifetime and stdio. No scheduling, task or permission policy.
#pragma once
#include <mutex>
#include <atomic>
#include "process-quiescence.h"

namespace windows_process {

struct Process {
  HANDLE job = nullptr;
  HANDLE root = nullptr;
  DWORD pid = 0;
  std::unique_ptr<SuspendedThreads> suspended;
  std::mutex control;
  std::atomic<unsigned int> pending_controls{0};
  ~Process() {
    // Closing the last non-inheritable Job handle kills every remaining member.
    if (job) CloseHandle(job);
    suspended.reset();
    if (root) CloseHandle(root);
  }
};

struct StdioPair {
  std::unique_ptr<PipeConnection> parent;
  std::unique_ptr<Handle> child;
  StdioPair() {
    BYTE random[24];
    require(BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, "stdio pipe identity");
    std::wstring name = L"\\\\.\\pipe\\metawork-stdio-";
    for (const auto byte : random) { name += L"0123456789abcdef"[byte >> 4]; name += L"0123456789abcdef"[byte & 15]; }
    Security security;
    parent = std::make_unique<PipeConnection>();
    parent->handle = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 65536, 65536, 0, security.get());
    require(parent->handle != INVALID_HANDLE_VALUE, "create process stdio");
    SECURITY_ATTRIBUTES attributes{ sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE };
    child = std::make_unique<Handle>(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0,
      &attributes, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
    require(child->get() != INVALID_HANDLE_VALUE, "connect process stdio");
    require(ConnectNamedPipe(parent->handle, &parent->accept.value) != FALSE || GetLastError() == ERROR_PIPE_CONNECTED,
      "accept process stdio");
  }
};

const napi_type_tag process_tag = { 0x6d657461776f726b, 0x6a6f6270726f6331 };

void property(napi_env env, napi_value object, const char* name, napi_value value) {
  require(napi_set_named_property(env, object, name, value) == napi_ok, "process result property");
}

struct AttributeList {
  std::vector<BYTE> storage;
  LPPROC_THREAD_ATTRIBUTE_LIST value = nullptr;
  explicit AttributeList(HANDLE* handles, size_t count) {
    SIZE_T length = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &length);
    storage.resize(length);
    value = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
    require(InitializeProcThreadAttributeList(value, 1, 0, &length) != FALSE, "process attribute list");
    if (!UpdateProcThreadAttribute(value, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, count * sizeof(HANDLE), nullptr, nullptr)) {
      DeleteProcThreadAttributeList(value); value = nullptr;
      require(false, "process inherited handle allowlist");
    }
  }
  ~AttributeList() { if (value) DeleteProcThreadAttributeList(value); }
};

napi_value spawn(napi_env env, napi_value* args) {
  const auto executable = string_argument(env, args[0]);
  auto command = string_argument(env, args[1]);
  const auto cwd = string_argument(env, args[2]);
  auto environment = string_argument(env, args[3]);
  require(!executable.empty() && executable.find(L'\0') == std::wstring::npos
    && !command.empty() && command.find(L'\0') == std::wstring::npos
    && !cwd.empty() && cwd.find(L'\0') == std::wstring::npos, "process paths and command line");
  require(environment.size() >= 2 && environment.back() == L'\0'
    && environment[environment.size() - 2] == L'\0', "terminated Unicode environment block");
  auto owned = std::make_unique<Process>();
  owned->job = CreateJobObjectW(nullptr, nullptr);
  require(owned->job != nullptr, "create owned process Job");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  require(SetInformationJobObject(owned->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != FALSE, "Job lifetime");
  StdioPair input, output, error;
  HANDLE inherited[] = { input.child->get(), output.child->get(), error.child->get() };
  AttributeList attributes(inherited, 3);
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = inherited[0];
  startup.StartupInfo.hStdOutput = inherited[1];
  startup.StartupInfo.hStdError = inherited[2];
  startup.lpAttributeList = attributes.value;
  PROCESS_INFORMATION child{};
  require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
    CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
    environment.data(), cwd.c_str(), &startup.StartupInfo, &child) != FALSE, "create suspended owned process");
  owned->root = child.hProcess; owned->pid = child.dwProcessId;
  Handle thread(child.hThread);
  if (!AssignProcessToJobObject(owned->job, owned->root)) {
    TerminateProcess(owned->root, 1);
    require(false, "assign process to Job before execution");
  }
  owned->suspended = std::make_unique<SuspendedThreads>(owned->job);
  napi_value result, pid;
  require(napi_create_object(env, &result) == napi_ok, "process result");
  napi_create_uint32(env, owned->pid, &pid);
  property(env, result, "pid", pid);
  input.parent->peer = output.parent->peer = error.parent->peer = owned->pid;
  property(env, result, "stdin", export_handle(env, std::move(input.parent), connection_tag));
  property(env, result, "stdout", export_handle(env, std::move(output.parent), connection_tag));
  property(env, result, "stderr", export_handle(env, std::move(error.parent), connection_tag));
  require(ResumeThread(thread.get()) != static_cast<DWORD>(-1), "resume owned process");
  property(env, result, "handle", export_handle(env, std::move(owned), process_tag));
  return result;
}

struct ControlWork {
  Process* process;
  bool pause;
  napi_ref retained;
  napi_deferred deferred;
  napi_async_work work;
  std::string error;
};

napi_value control(napi_env env, napi_value handle, Process* process, bool pause) {
  auto pending = std::make_unique<ControlWork>();
  pending->process = process; pending->pause = pause;
  napi_value promise, name;
  require(napi_create_promise(env, &pending->deferred, &promise) == napi_ok, "process control promise");
  require(napi_create_reference(env, handle, 1, &pending->retained) == napi_ok, "retain controlled process");
  napi_create_string_utf8(env, "MetaWork process control", NAPI_AUTO_LENGTH, &name);
  const auto status = napi_create_async_work(env, nullptr, name, [](napi_env, void* data) {
    auto task = static_cast<ControlWork*>(data);
    std::lock_guard<std::mutex> lock(task->process->control);
    try {
      if (task->pause) task->process->suspended->pause();
      else task->process->suspended->resume();
    } catch (const std::exception& error) {
      task->error = error.what();
      task->process->suspended->resume(false);
    }
  }, [](napi_env callback_env, napi_status callback_status, void* data) {
    std::unique_ptr<ControlWork> task(static_cast<ControlWork*>(data));
    napi_value result;
    if (callback_status == napi_ok && task->error.empty()) {
      napi_get_undefined(callback_env, &result); napi_resolve_deferred(callback_env, task->deferred, result);
    } else {
      napi_value message;
      const auto reason = task->error.empty() ? "Process control cancelled" : task->error.c_str();
      napi_create_string_utf8(callback_env, reason, NAPI_AUTO_LENGTH, &message);
      napi_create_error(callback_env, nullptr, message, &result); napi_reject_deferred(callback_env, task->deferred, result);
    }
    task->process->pending_controls.fetch_sub(1);
    napi_delete_reference(callback_env, task->retained); napi_delete_async_work(callback_env, task->work);
  }, pending.get(), &pending->work);
  if (status != napi_ok) { napi_delete_reference(env, pending->retained); require(false, "process async control"); }
  process->pending_controls.fetch_add(1);
  if (napi_queue_async_work(env, pending->work) != napi_ok) {
    process->pending_controls.fetch_sub(1);
    napi_delete_reference(env, pending->retained); napi_delete_async_work(env, pending->work);
    require(false, "queue process control");
  }
  pending.release();
  return promise;
}

napi_value operations(napi_env env, napi_callback_info info) {
  try {
    napi_value args[4], result; size_t count = 4; void* mode = nullptr;
    require(napi_get_cb_info(env, info, &count, args, nullptr, &mode) == napi_ok, "process arguments");
    const std::string operation(static_cast<const char*>(mode));
    if (operation == "processSpawn") {
      require(count == 4, "process spawn arguments"); return spawn(env, args);
    }
    require(count == 1, "owned process handle required");
    auto process = pipe_handle<Process>(env, args[0], process_tag);
    require(process->job != nullptr && process->root != nullptr, "open process required");
    if (operation == "processDispose") {
      if (process->pending_controls.load() != 0) { napi_get_boolean(env, false, &result); return result; }
      std::unique_lock<std::mutex> lock(process->control, std::try_to_lock);
      if (!lock.owns_lock()) { napi_get_boolean(env, false, &result); return result; }
      JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
      require(QueryInformationJobObject(process->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) != FALSE,
        "check completed Job");
      require(accounting.ActiveProcesses == 0, "empty Job required before disposal");
      process->suspended.reset();
      CloseHandle(process->job); process->job = nullptr;
      CloseHandle(process->root); process->root = nullptr;
      napi_get_boolean(env, true, &result); return result;
    }
    if (operation == "processPause" || operation == "processResume") return control(env, args[0], process, operation == "processPause");
    if (operation == "processKill") {
      require(TerminateJobObject(process->job, 1) != FALSE, "terminate owned Job");
      napi_get_undefined(env, &result); return result;
    }
    require(operation == "processStatus", "known process operation");
    DWORD code = 0;
    const bool exited = WaitForSingleObject(process->root, 0) == WAIT_OBJECT_0;
    if (exited) require(GetExitCodeProcess(process->root, &code) != FALSE, "owned process exit code");
    JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
    require(QueryInformationJobObject(process->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) != FALSE,
      "owned Job active processes");
    napi_value value;
    napi_create_object(env, &result);
    if (exited) napi_create_uint32(env, code, &value); else napi_get_null(env, &value);
    property(env, result, "exitCode", value);
    napi_create_uint32(env, accounting.ActiveProcesses, &value); property(env, result, "activeProcesses", value);
    return result;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what()); return nullptr;
  }
}
}
