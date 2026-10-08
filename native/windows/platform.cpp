// Narrow platform module. Production callers must pass through their owned adapters.
#include <node_api.h>
#include "security.h"
#include "private-file.h"
#include "private-write.h"

std::wstring string_argument(napi_env env, napi_value value) {
  size_t length = 0;
  if (napi_get_value_string_utf16(env, value, nullptr, 0, &length) != napi_ok || length > 32767)
    throw std::runtime_error("Bounded path required");
  std::vector<char16_t> text(length + 1);
  if (napi_get_value_string_utf16(env, value, text.data(), text.size(), &length) != napi_ok)
    throw std::runtime_error("Path argument required");
  return std::wstring(reinterpret_cast<wchar_t*>(text.data()), length);
}

#include "pipe.h"

napi_value files(napi_env env, napi_callback_info info) {
  try {
    napi_value arguments[4];
    size_t count = 4;
    void* mode = nullptr;
    if (napi_get_cb_info(env, info, &count, arguments, nullptr, &mode) != napi_ok)
      throw std::runtime_error("Platform arguments required");
    const std::string operation(static_cast<const char*>(mode));
    uint32_t maximum = 65536;
    if ((operation == "readPrivateFile" && count == 3) || (operation == "writePrivateFile" && count == 4)) {
      double limit = 0;
      if (napi_get_value_double(env, arguments[count - 1], &limit) != napi_ok
        || !(limit >= 1 && limit <= 9 * 1024 * 1024) || limit != static_cast<uint32_t>(limit))
        throw std::runtime_error("Explicit file size limit required");
      maximum = static_cast<uint32_t>(limit);
    }
    napi_value result;
    if (operation == "ensurePrivateDirectory") {
      if (count != 1) throw std::runtime_error("Directory required");
      ensure_private_directory(string_argument(env, arguments[0]));
    } else if (operation == "readPrivateFile") {
      if (count != 2 && count != 3) throw std::runtime_error("Root and relative file required");
      const auto data = read_private_file(string_argument(env, arguments[0]), string_argument(env, arguments[1]), maximum);
      if (napi_create_buffer_copy(env, data.size(), data.data(), nullptr, &result) != napi_ok)
        throw std::runtime_error("File result allocation");
      return result;
    } else {
      void* bytes = nullptr;
      size_t length = 0;
      if ((count != 3 && count != 4) || napi_get_buffer_info(env, arguments[2], &bytes, &length) != napi_ok)
        throw std::runtime_error("Root, relative file and bounded buffer required");
      write_private_file(string_argument(env, arguments[0]), string_argument(env, arguments[1]), static_cast<BYTE*>(bytes), length, maximum);
    }
    napi_get_undefined(env, &result); return result;
  } catch (const PrivateFileNotFound& error) {
    napi_throw_error(env, "ENOENT", error.what()); return nullptr;
  } catch (const std::exception& error) {
    napi_throw_error(env, nullptr, error.what()); return nullptr;
  }
}

napi_value initialize(napi_env env, napi_value exports) {
  for (const char* name : { "ensurePrivateDirectory", "readPrivateFile", "writePrivateFile" }) {
    napi_value function;
    if (napi_create_function(env, name, NAPI_AUTO_LENGTH, files, const_cast<char*>(name), &function) != napi_ok
      || napi_set_named_property(env, exports, name, function) != napi_ok) {
      napi_throw_error(env, nullptr, "Platform initialization failed"); return nullptr;
    }
  }
  for (const char* name : { "pipeListen", "pipeAccept", "pipeConnect", "pipePeerPid", "pipeRead",
      "pipeWrite", "pipeWriteReady", "pipeClose", "pipeCloseListener" }) {
    napi_value function;
    if (napi_create_function(env, name, NAPI_AUTO_LENGTH, pipes, const_cast<char*>(name), &function) != napi_ok
      || napi_set_named_property(env, exports, name, function) != napi_ok) {
      napi_throw_error(env, nullptr, "Pipe initialization failed"); return nullptr;
    }
  }
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
