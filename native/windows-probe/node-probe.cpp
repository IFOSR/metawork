// P0 carrier comparison only: no product code imports this module.
#include <node_api.h>
#define METAWORK_NODE_PROBE
#include "pipe-probe.cpp"
#include "private-file.h"

std::wstring string_argument(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > 32767)
    throw std::runtime_error("Bounded path required");
  std::vector<char16_t> text(length + 1);
  if (napi_get_value_string_utf16(env, value, text.data(), text.size(), &length) != napi_ok)
    throw std::runtime_error("Path argument required");
  return std::wstring(reinterpret_cast<wchar_t*>(text.data()), length);
}

napi_value read_private(napi_env env, napi_callback_info info) {
  try {
    napi_value arguments[2];
    size_t count = 2;
    if (napi_get_cb_info(env, info, &count, arguments, nullptr, nullptr) != napi_ok || count != 2)
      throw std::runtime_error("Root and relative file required");
    const auto data = read_private_file(string_argument(env, arguments[0]), string_argument(env, arguments[1]));
    napi_value result;
    if (napi_create_buffer_copy(env, data.size(), data.data(), nullptr, &result) != napi_ok)
      throw std::runtime_error("Private file result");
    return result;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value probe(napi_env env, napi_callback_info) {
  try {
    Security security;
    const auto name = L"\\\\.\\pipe\\metawork-p0-napi-" + std::to_wstring(GetCurrentProcessId());
    Handle server(create_pipe(name.c_str(), security));
    require(server.get() != INVALID_HANDLE_VALUE, "Node-API pipe create");
    inspect_security(server.get());
    Handle client_pipe(CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
      0, nullptr, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
    require(client_pipe.get() != INVALID_HANDLE_VALUE, "Node-API pipe connect");
    require(ConnectNamedPipe(server.get(), nullptr) != FALSE || GetLastError() == ERROR_PIPE_CONNECTED,
      "Node-API server connect");
    ULONG pid = 0;
    require(GetNamedPipeServerProcessId(client_pipe.get(), &pid) != FALSE, "Node-API server PID");
    require(pid == GetCurrentProcessId(), "pipe owned by host process");
    same_user(pid);
    inspect_security(client_pipe.get());
    require(DisconnectNamedPipe(server.get()) != FALSE, "Node-API disconnect");
    napi_value result;
    if (napi_create_uint32(env, pid, &result) != napi_ok) throw std::runtime_error("Node-API result");
    return result;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what());
    return nullptr;
  }
}

napi_value initialize(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "probe", NAPI_AUTO_LENGTH, probe, nullptr, &function) != napi_ok
    || napi_set_named_property(env, exports, "probe", function) != napi_ok) {
    napi_throw_error(env, nullptr, "Node-API initialization failed");
    return nullptr;
  }
  if (napi_create_function(env, "readPrivateFile", NAPI_AUTO_LENGTH, read_private, nullptr, &function) != napi_ok
    || napi_set_named_property(env, exports, "readPrivateFile", function) != napi_ok) {
    napi_throw_error(env, nullptr, "File probe initialization failed");
    return nullptr;
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
