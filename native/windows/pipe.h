// Owned overlapped handles. JavaScript polls completion without blocking its
// event loop; no Node/libuv private handles or product authorization policy.
#pragma once
#include <array>

struct PipeIo {
  OVERLAPPED value{};
  bool pending = false;
  PipeIo() {
    value.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    require(value.hEvent != nullptr, "pipe event");
  }
  ~PipeIo() { release(); }
  void release() {
    if (value.hEvent) { CloseHandle(value.hEvent); value.hEvent = nullptr; }
  }
  void reset() {
    require(!pending, "completed pipe operation required");
    const auto event = value.hEvent;
    value = {}; value.hEvent = event;
    require(ResetEvent(event) != FALSE, "reset pipe event");
  }
};

struct PipeConnection {
  HANDLE handle = INVALID_HANDLE_VALUE;
  PipeIo accept, read, write;
  ULONG peer = 0;
  bool eof = false;
  std::array<BYTE, 65536> input{};
  std::vector<BYTE> output;
  ~PipeConnection() { close(); }
  void close() {
    if (handle == INVALID_HANDLE_VALUE) return;
    CancelIoEx(handle, nullptr);
    for (auto operation : { &accept, &read, &write }) {
      if (operation->pending) {
        DWORD transferred = 0;
        // Cancellation is asynchronous: buffers/OVERLAPPED must remain alive
        // until the kernel has acknowledged completion, including on GC.
        GetOverlappedResult(handle, &operation->value, &transferred, TRUE);
        operation->pending = false;
      }
      operation->release();
    }
    CloseHandle(handle); handle = INVALID_HANDLE_VALUE;
  }
  void require_open() { require(handle != INVALID_HANDLE_VALUE, "open pipe required"); }
  bool complete(PipeIo& operation, DWORD& bytes, bool reading = false) {
    if (!operation.pending) return true;
    if (!GetOverlappedResult(handle, &operation.value, &bytes, FALSE)) {
      const auto error = GetLastError();
      if (error == ERROR_IO_INCOMPLETE) return false;
      operation.pending = false;
      if (reading && (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED)) {
        eof = true; bytes = 0; return true;
      }
      SetLastError(error); require(false, "pipe completion");
    }
    operation.pending = false;
    return true;
  }
};

struct PipeListener {
  std::wstring name;
  std::unique_ptr<PipeConnection> pending;
  explicit PipeListener(const std::wstring& path) : name(path), pending(instance(true)) {}
  std::unique_ptr<PipeConnection> instance(bool first) {
    auto pipe = std::make_unique<PipeConnection>();
    Security security;
    pipe->handle = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED
      | (first ? FILE_FLAG_FIRST_PIPE_INSTANCE : 0),
      PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
      PIPE_UNLIMITED_INSTANCES, 65536, 65536, 0, security.get());
    require(pipe->handle != INVALID_HANDLE_VALUE, "create owned pipe listener");
    inspect_security(pipe->handle);
    if (!ConnectNamedPipe(pipe->handle, &pipe->accept.value)) {
      const auto error = GetLastError();
      require(error == ERROR_IO_PENDING || error == ERROR_PIPE_CONNECTED, "begin pipe accept");
      pipe->accept.pending = error == ERROR_IO_PENDING;
    }
    return pipe;
  }
};

const napi_type_tag connection_tag = { 0x6d657461776f726b, 0x70697065636f6e31 };
const napi_type_tag listener_tag = { 0x6d657461776f726b, 0x706970656c697331 };

template<class T> T* pipe_handle(napi_env env, napi_value value, const napi_type_tag& tag) {
  bool tagged = false; void* data = nullptr;
  if (napi_check_object_type_tag(env, value, &tag, &tagged) != napi_ok || !tagged
    || napi_get_value_external(env, value, &data) != napi_ok || !data)
    throw std::runtime_error("Owned native pipe handle required");
  return static_cast<T*>(data);
}

template<class T> napi_value export_handle(napi_env env, std::unique_ptr<T> handle, const napi_type_tag& tag) {
  napi_value result;
  if (napi_create_external(env, handle.get(), [](napi_env, void* data, void*) {
    delete static_cast<T*>(data);
  }, nullptr, &result) != napi_ok) throw std::runtime_error("Pipe handle allocation");
  handle.release();
  if (napi_type_tag_object(env, result, &tag) != napi_ok) throw std::runtime_error("Pipe handle tag");
  return result;
}

void validate_pipe_name(const std::wstring& name) {
  const std::wstring prefix = L"\\\\.\\pipe\\metawork-";
  require(name.size() > prefix.size() && name.size() <= 240 && name.find(prefix) == 0,
    "local MetaWork pipe name required");
  for (size_t index = prefix.size(); index < name.size(); index++) {
    const auto c = name[index];
    require((c >= L'a' && c <= L'z') || (c >= L'A' && c <= L'Z') || (c >= L'0' && c <= L'9')
      || c == L'.' || c == L'_' || c == L'-', "safe pipe name required");
  }
}

napi_value pipes(napi_env env, napi_callback_info info) {
  try {
    napi_value args[3]; size_t count = 3; void* mode = nullptr;
    if (napi_get_cb_info(env, info, &count, args, nullptr, &mode) != napi_ok || count < 1)
      throw std::runtime_error("Pipe arguments required");
    const std::string operation(static_cast<const char*>(mode));
    napi_value result;
    if (operation == "pipeListen" || operation == "pipeConnect") {
      const auto name = string_argument(env, args[0]); validate_pipe_name(name);
      if (operation == "pipeListen") {
        if (count != 1) throw std::runtime_error("Listener name required");
        return export_handle(env, std::make_unique<PipeListener>(name), listener_tag);
      }
      double expected = 0;
      if (count != 2 || napi_get_value_double(env, args[1], &expected) != napi_ok
        || !(expected >= 1 && expected <= MAXDWORD) || expected != static_cast<DWORD>(expected))
        throw std::runtime_error("Expected server PID required");
      auto pipe = std::make_unique<PipeConnection>();
      pipe->handle = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
        0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
      if (pipe->handle == INVALID_HANDLE_VALUE && GetLastError() == ERROR_PIPE_BUSY) {
        napi_get_null(env, &result); return result;
      }
      require(pipe->handle != INVALID_HANDLE_VALUE, "connect owned pipe");
      require(GetNamedPipeServerProcessId(pipe->handle, &pipe->peer) != FALSE
        && pipe->peer == static_cast<DWORD>(expected), "pipe server PID mismatch");
      same_user(pipe->peer); inspect_security(pipe->handle);
      return export_handle(env, std::move(pipe), connection_tag);
    }
    if (operation == "pipeAccept" || operation == "pipeCloseListener") {
      if (count != 1) throw std::runtime_error("Listener handle required");
      auto listener = pipe_handle<PipeListener>(env, args[0], listener_tag);
      if (operation == "pipeCloseListener") {
        listener->pending.reset(); napi_get_undefined(env, &result); return result;
      }
      require(listener->pending != nullptr, "open listener required");
      DWORD bytes = 0;
      if (!listener->pending->complete(listener->pending->accept, bytes)) {
        napi_get_null(env, &result); return result;
      }
      // Create the next pending instance BEFORE releasing the accepted one.
      // The owned name never has an unguarded gap, including sequential clients.
      auto next = listener->instance(false);
      auto connected = std::move(listener->pending);
      listener->pending = std::move(next);
      require(GetNamedPipeClientProcessId(connected->handle, &connected->peer) != FALSE, "pipe client PID");
      same_user(connected->peer);
      return export_handle(env, std::move(connected), connection_tag);
    }
    auto pipe = pipe_handle<PipeConnection>(env, args[0], connection_tag);
    if (operation == "pipeClose") {
      pipe->close(); napi_get_undefined(env, &result); return result;
    }
    pipe->require_open();
    if (operation == "pipePeerPid") {
      napi_create_uint32(env, pipe->peer, &result); return result;
    }
    DWORD bytes = 0;
    if (operation == "pipeRead") {
      if (!pipe->eof && !pipe->read.pending) {
        pipe->read.reset();
        if (!ReadFile(pipe->handle, pipe->input.data(), static_cast<DWORD>(pipe->input.size()), &bytes, &pipe->read.value)) {
          const auto error = GetLastError();
          if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) pipe->eof = true;
          else { require(error == ERROR_IO_PENDING, "begin pipe read"); pipe->read.pending = true; }
        }
      }
      if (!pipe->complete(pipe->read, bytes, true)) { napi_get_null(env, &result); return result; }
      if (napi_create_buffer_copy(env, bytes, pipe->input.data(), nullptr, &result) != napi_ok)
        throw std::runtime_error("Pipe read allocation");
      return result;
    }
    if (operation == "pipeWrite") {
      void* data = nullptr; size_t size = 0;
      if (count != 2 || napi_get_buffer_info(env, args[1], &data, &size) != napi_ok || !size || size > 65536)
        throw std::runtime_error("Bounded pipe write required");
      require(!pipe->write.pending, "one pending pipe write required");
      pipe->output.assign(static_cast<BYTE*>(data), static_cast<BYTE*>(data) + size);
      pipe->write.reset();
      if (!WriteFile(pipe->handle, pipe->output.data(), static_cast<DWORD>(size), &bytes, &pipe->write.value)) {
        require(GetLastError() == ERROR_IO_PENDING, "begin pipe write"); pipe->write.pending = true;
      }
      if (!pipe->write.pending) require(bytes == size, "complete pipe write");
    } else if (operation != "pipeWriteReady") throw std::runtime_error("Unknown pipe operation");
    if (pipe->write.pending) {
      if (!pipe->complete(pipe->write, bytes)) { napi_get_boolean(env, false, &result); return result; }
      require(bytes == pipe->output.size(), "complete pending pipe write");
    }
    pipe->output.clear(); napi_get_boolean(env, true, &result); return result;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what()); return nullptr;
  }
}
