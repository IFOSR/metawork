// P0 carrier comparison only: no product code imports this module.
#include <node_api.h>
#define METAWORK_NODE_PROBE
#include "pipe-probe.cpp"

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
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
