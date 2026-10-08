// P0 executable only. Not linked into or shipped with the product.
#include "../windows/security.h"
HANDLE create_pipe(const wchar_t* name, Security& security, bool reject_remote = true) {
  return CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | (reject_remote ? PIPE_REJECT_REMOTE_CLIENTS : 0),
    // Leave capacity for a second instance so FIRST_PIPE_INSTANCE itself is
    // exercised, rather than failing first with ERROR_PIPE_BUSY at the limit.
    2, 4096, 4096, 5000, security.get());
}

void serve(const wchar_t* name, const wchar_t* ready_path, bool standard_user, bool remote_control = false) {
  HANDLE raw = nullptr;
  require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw) != FALSE, "elevation token");
  Handle token(raw);
  TOKEN_ELEVATION elevation{};
  DWORD size = sizeof(elevation);
  require(GetTokenInformation(token.get(), TokenElevation, &elevation, size, &size) != FALSE,
    "TokenElevation");
  if (standard_user) require(!elevation.TokenIsElevated, "non-elevated server required");
  Security security;
  Handle pipe(create_pipe(name, security, !remote_control));
  require(pipe.get() != INVALID_HANDLE_VALUE, "CreateNamedPipe first instance");
  inspect_security(pipe.get());
  Handle duplicate(create_pipe(name, security, !remote_control));
  require(duplicate.get() == INVALID_HANDLE_VALUE && GetLastError() == ERROR_ACCESS_DENIED,
    "first-instance squatting guard");
  {
    // Fixture coordination only: inherit the fixture directory ACL so the
    // orchestrator can observe readiness even when Server is a standard user.
    Handle ready(CreateFileW(ready_path, GENERIC_WRITE, 0, nullptr, CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    require(ready.get() != INVALID_HANDLE_VALUE, "ready file");
    const auto pid = std::to_string(GetCurrentProcessId());
    DWORD written = 0;
    require(WriteFile(ready.get(), pid.data(), static_cast<DWORD>(pid.size()), &written, nullptr) != FALSE,
      "ready write");
  }
  for (unsigned int attempt = 0; attempt < 8; attempt++) {
    require(ConnectNamedPipe(pipe.get(), nullptr) != FALSE || GetLastError() == ERROR_PIPE_CONNECTED,
      "ConnectNamedPipe");
    char command = 0;
    DWORD read = 0;
    const bool received = ReadFile(pipe.get(), &command, 1, &read, nullptr) != FALSE && read == 1;
    if (received) {
      if (!remote_control) {
        ULONG pid = 0;
        require(GetNamedPipeClientProcessId(pipe.get(), &pid) != FALSE, "kernel client PID");
        same_user(pid);
      }
      require(command == 'P' || command == 'Q', "bounded probe command");
      DWORD written = 0;
      require(WriteFile(pipe.get(), &command, 1, &written, nullptr) != FALSE && written == 1, "response");
      require(FlushFileBuffers(pipe.get()) != FALSE, "flush response");
    }
    require(DisconnectNamedPipe(pipe.get()) != FALSE, "disconnect");
    if (received && command == 'Q') {
      std::cout << "{\"ownerDacl\":true,\"firstInstanceGuard\":true,\"kernelClientIdentity\":"
        << (remote_control ? "false" : "true") << ",\"remoteRejectionConfigured\":"
        << (remote_control ? "false" : "true") << ",\"elevated\":"
        << (elevation.TokenIsElevated ? "true" : "false") << "}\n";
      return;
    }
  }
  throw std::runtime_error("Probe connection budget exhausted");
}

void client(const wchar_t* name, DWORD expected, bool denied, bool stop, bool wrong_pid, bool remote = false) {
  Handle pipe(CreateFileW(name, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
    0, nullptr, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
  const DWORD opened = GetLastError();
  if (denied) {
    require(pipe.get() == INVALID_HANDLE_VALUE && opened == ERROR_ACCESS_DENIED,
      remote ? "remote client denial" : "cross-account denial");
    std::cout << (remote ? "{\"remoteClientDenied\":true}\n" : "{\"crossAccountDenied\":true}\n");
    return;
  }
  require(pipe.get() != INVALID_HANDLE_VALUE, "client open");
  if (!remote) {
    ULONG actual = 0;
    require(GetNamedPipeServerProcessId(pipe.get(), &actual) != FALSE, "kernel server PID");
    if (wrong_pid) {
      require(actual != expected, "spoofed PID rejected");
      std::cout << "{\"spoofedPidRejected\":true}\n";
      return;
    }
    require(actual == expected, "server PID mismatch");
    same_user(actual);
    inspect_security(pipe.get());
  }
  const char command = stop ? 'Q' : 'P';
  DWORD written = 0;
  require(WriteFile(pipe.get(), &command, 1, &written, nullptr) != FALSE && written == 1, "request");
  char reply = 0;
  DWORD read = 0;
  require(ReadFile(pipe.get(), &reply, 1, &read, nullptr) != FALSE && read == 1 && reply == command, "reply");
  std::cout << "{\"kernelServerIdentity\":" << (remote ? "false" : "true")
    << ",\"roundTrip\":true,\"smbLoopback\":" << (remote ? "true" : "false") << "}\n";
}

#ifndef METAWORK_NODE_PROBE
int wmain(int argc, wchar_t** argv) {
  try {
    if (argc < 4) throw std::runtime_error("Explicit P0 pipe and mode arguments required");
    const std::wstring mode(argv[1]);
    const bool remote = mode == L"remote" || mode == L"remote-denied";
    wchar_t host[MAX_COMPUTERNAME_LENGTH + 1];
    DWORD size = MAX_COMPUTERNAME_LENGTH + 1;
    require(GetComputerNameW(host, &size) != FALSE, "local computer name");
    const std::wstring prefix = remote ? L"\\\\" + std::wstring(host) + L"\\pipe\\metawork-p0-"
      : L"\\\\.\\pipe\\metawork-p0-";
    if (std::wstring(argv[2]).find(prefix) != 0) throw std::runtime_error("Only local P0 fixture pipes allowed");
    if (mode == L"serve" || mode == L"serve-standard" || mode == L"serve-remote-control")
      serve(argv[2], argv[3], mode == L"serve-standard", mode == L"serve-remote-control");
    else if (remote) client(argv[2], 0, mode == L"remote-denied", false, false, true);
    else if (mode == L"client" || mode == L"stop" || mode == L"denied" || mode == L"wrong-pid")
      client(argv[2], std::stoul(argv[3]), mode == L"denied", mode == L"stop", mode == L"wrong-pid");
    else throw std::runtime_error("Unknown probe mode");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
#endif
