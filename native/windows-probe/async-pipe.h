// P0 nonblocking transport primitives. No Node or libuv private handle access.
#pragma once
#include <array>

struct PendingIo {
  OVERLAPPED value{};
  bool pending = false;
  PendingIo() {
    value.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    require(value.hEvent != nullptr, "overlapped event");
  }
  ~PendingIo() { release(); }
  void release() {
    if (value.hEvent) { CloseHandle(value.hEvent); value.hEvent = nullptr; }
  }
  void reset() {
    const HANDLE event = value.hEvent;
    value = {}; value.hEvent = event;
    require(ResetEvent(event) != FALSE, "reset event");
  }
};

struct AsyncPipe {
  HANDLE handle = INVALID_HANDLE_VALUE;
  PendingIo accept, read, write;
  bool connected = false;
  std::array<BYTE, 65536> input{};
  std::vector<BYTE> output;
  ~AsyncPipe() { close(); }
  void close() {
    if (handle == INVALID_HANDLE_VALUE) return;
    CancelIoEx(handle, nullptr);
    for (auto operation : { &accept, &read, &write }) {
      if (operation->pending) {
        DWORD transferred = 0;
        // CancelIoEx may return before completion. Keep OVERLAPPED and its
        // buffers alive until the kernel has released them.
        GetOverlappedResult(handle, &operation->value, &transferred, TRUE);
        operation->pending = false;
      }
    }
    CloseHandle(handle); handle = INVALID_HANDLE_VALUE; connected = false;
    accept.release(); read.release(); write.release();
  }
  void open() { require(handle != INVALID_HANDLE_VALUE, "pipe is closed"); }
  bool complete(PendingIo& operation, DWORD& bytes) {
    if (!operation.pending) return true;
    if (!GetOverlappedResult(handle, &operation.value, &bytes, FALSE)) {
      if (GetLastError() == ERROR_IO_INCOMPLETE) return false;
      operation.pending = false;
      require(false, "overlapped completion");
    }
    operation.pending = false;
    return true;
  }
};

const napi_type_tag async_pipe_tag = { 0x6d657461776f726b, 0x77696e7069706531 };

AsyncPipe* pipe_argument(napi_env env, napi_value value) {
  bool tagged = false;
  void* data = nullptr;
  if (napi_check_object_type_tag(env, value, &async_pipe_tag, &tagged) != napi_ok || !tagged
    || napi_get_value_external(env, value, &data) != napi_ok || !data)
    throw std::runtime_error("Owned pipe handle required");
  return static_cast<AsyncPipe*>(data);
}

napi_value export_pipe(napi_env env, std::unique_ptr<AsyncPipe> pipe) {
  napi_value result;
  if (napi_create_external(env, pipe.get(), [](napi_env, void* data, void*) {
    delete static_cast<AsyncPipe*>(data);
  }, nullptr, &result) != napi_ok) throw std::runtime_error("Pipe handle allocation");
  pipe.release();
  if (napi_type_tag_object(env, result, &async_pipe_tag) != napi_ok)
    throw std::runtime_error("Pipe handle type tag");
  return result;
}

napi_value pipe_operation(napi_env env, napi_callback_info info) {
  try {
    napi_value args[3];
    size_t count = 3;
    void* raw_mode = nullptr;
    if (napi_get_cb_info(env, info, &count, args, nullptr, &raw_mode) != napi_ok || count < 1)
      throw std::runtime_error("Pipe arguments required");
    const std::string mode(static_cast<const char*>(raw_mode));
    napi_value result;
    if (mode == "listen" || mode == "connect") {
      const auto name = string_argument(env, args[0]);
      require(name.find(L"\\\\.\\pipe\\metawork-p0-") == 0 && name.find(L'\0') == std::wstring::npos,
        "P0 pipe name required");
      auto pipe = std::make_unique<AsyncPipe>();
      if (mode == "listen") {
        Security security;
        pipe->handle = CreateNamedPipeW(name.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
          PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
          2, 65536, 65536, 5000, security.get());
        require(pipe->handle != INVALID_HANDLE_VALUE, "async pipe create");
        inspect_security(pipe->handle);
        if (!ConnectNamedPipe(pipe->handle, &pipe->accept.value)) {
          const DWORD error = GetLastError();
          require(error == ERROR_IO_PENDING || error == ERROR_PIPE_CONNECTED, "async accept");
          pipe->accept.pending = error == ERROR_IO_PENDING;
        }
      } else {
        uint32_t expected = 0;
        if (count != 2 || napi_get_value_uint32(env, args[1], &expected) != napi_ok || !expected)
          throw std::runtime_error("Expected peer PID required");
        pipe->handle = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
          0, nullptr, OPEN_EXISTING, FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr);
        require(pipe->handle != INVALID_HANDLE_VALUE, "async client open");
        ULONG actual = 0;
        require(GetNamedPipeServerProcessId(pipe->handle, &actual) != FALSE && actual == expected, "async peer PID");
        same_user(actual); inspect_security(pipe->handle); pipe->connected = true;
      }
      return export_pipe(env, std::move(pipe));
    }
    auto pipe = pipe_argument(env, args[0]);
    if (mode == "close") {
      pipe->close(); napi_get_undefined(env, &result); return result;
    }
    pipe->open();
    DWORD transferred = 0;
    if (mode == "accept") {
      if (!pipe->connected && pipe->complete(pipe->accept, transferred)) {
        ULONG pid = 0;
        require(GetNamedPipeClientProcessId(pipe->handle, &pid) != FALSE, "async client PID");
        same_user(pid); pipe->connected = true;
      }
      napi_get_boolean(env, pipe->connected, &result); return result;
    }
    require(pipe->connected, "pipe connection required");
    if (mode == "read") {
      if (!pipe->read.pending) {
        pipe->read.reset();
        if (!ReadFile(pipe->handle, pipe->input.data(), static_cast<DWORD>(pipe->input.size()), &transferred, &pipe->read.value)) {
          require(GetLastError() == ERROR_IO_PENDING, "async read");
          pipe->read.pending = true;
        }
      }
      if (!pipe->complete(pipe->read, transferred)) { napi_get_null(env, &result); return result; }
      if (napi_create_buffer_copy(env, transferred, pipe->input.data(), nullptr, &result) != napi_ok)
        throw std::runtime_error("Read result allocation");
      return result;
    }
    if (mode == "write") {
      void* bytes = nullptr;
      size_t length = 0;
      if (count != 2 || napi_get_buffer_info(env, args[1], &bytes, &length) != napi_ok || !length || length > 65536)
        throw std::runtime_error("Bounded nonempty buffer required");
      require(!pipe->write.pending, "one pending write required");
      pipe->output.assign(static_cast<BYTE*>(bytes), static_cast<BYTE*>(bytes) + length);
      pipe->write.reset();
      if (!WriteFile(pipe->handle, pipe->output.data(), static_cast<DWORD>(length), &transferred, &pipe->write.value)) {
        require(GetLastError() == ERROR_IO_PENDING, "async write");
        pipe->write.pending = true;
      }
      if (!pipe->write.pending) require(transferred == length, "complete immediate write");
    } else if (mode != "writeReady") throw std::runtime_error("Unknown pipe operation");
    if (pipe->write.pending) {
      if (!pipe->complete(pipe->write, transferred)) {
        napi_get_boolean(env, false, &result); return result;
      }
      require(transferred == pipe->output.size(), "complete pending write");
    }
    pipe->output.clear();
    napi_get_boolean(env, true, &result); return result;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}
