// P0 executable only. Not linked into or shipped with the product.
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

class Handle {
 public:
  explicit Handle(HANDLE value) : value_(value) {}
  ~Handle() { if (value_ && value_ != INVALID_HANDLE_VALUE) CloseHandle(value_); }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  HANDLE get() const { return value_; }
 private:
  HANDLE value_;
};

void require(bool ok, const char* operation) {
  if (!ok) throw std::runtime_error(std::string(operation) + " failed, Win32=" + std::to_string(GetLastError()));
}

std::vector<BYTE> process_user(HANDLE process) {
  HANDLE raw = nullptr;
  require(OpenProcessToken(process, TOKEN_QUERY, &raw) != FALSE, "OpenProcessToken");
  Handle token(raw);
  DWORD length = 0;
  GetTokenInformation(token.get(), TokenUser, nullptr, 0, &length);
  require(length > 0, "TokenUser size");
  std::vector<BYTE> data(length);
  require(GetTokenInformation(token.get(), TokenUser, data.data(), length, &length) != FALSE, "TokenUser");
  const auto user = reinterpret_cast<TOKEN_USER*>(data.data());
  std::vector<BYTE> sid(GetLengthSid(user->User.Sid));
  require(CopySid(static_cast<DWORD>(sid.size()), sid.data(), user->User.Sid) != FALSE, "CopySid");
  return sid;
}

void same_user(DWORD pid) {
  Handle process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid));
  require(process.get() != nullptr, "OpenProcess peer");
  auto peer = process_user(process.get());
  auto own = process_user(GetCurrentProcess());
  require(EqualSid(own.data(), peer.data()) != FALSE, "peer SID mismatch");
}

class Security {
 public:
  Security() {
    auto sid = process_user(GetCurrentProcess());
    LPWSTR text = nullptr;
    require(ConvertSidToStringSidW(sid.data(), &text) != FALSE, "SID text");
    const std::wstring identity(text);
    LocalFree(text);
    const auto sddl = L"O:" + identity + L"G:" + identity + L"D:P(A;;GA;;;" + identity + L")";
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
      &descriptor_, nullptr) != FALSE, "SDDL");
    attributes_ = { sizeof(SECURITY_ATTRIBUTES), descriptor_, FALSE };
  }
  ~Security() { LocalFree(descriptor_); }
  SECURITY_ATTRIBUTES* get() { return &attributes_; }
 private:
  PSECURITY_DESCRIPTOR descriptor_ = nullptr;
  SECURITY_ATTRIBUTES attributes_{};
};

HANDLE create_pipe(const wchar_t* name, Security& security) {
  return CreateNamedPipeW(name, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
    // Leave capacity for a second instance so FIRST_PIPE_INSTANCE itself is
    // exercised, rather than failing first with ERROR_PIPE_BUSY at the limit.
    2, 4096, 4096, 5000, security.get());
}

void inspect_security(HANDLE pipe) {
  PSID owner = nullptr;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD result = GetSecurityInfo(pipe, SE_KERNEL_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor);
  require(result == ERROR_SUCCESS, "GetSecurityInfo");
  auto sid = process_user(GetCurrentProcess());
  const bool valid_owner = owner && EqualSid(owner, sid.data());
  bool valid_acl = acl && acl->AceCount == 1;
  if (valid_acl) {
    void* raw_ace = nullptr;
    valid_acl = GetAce(acl, 0, &raw_ace) != FALSE;
    if (valid_acl) {
      const auto ace = static_cast<ACCESS_ALLOWED_ACE*>(raw_ace);
      valid_acl = ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE
        && EqualSid(&ace->SidStart, sid.data());
    }
  }
  LocalFree(descriptor);
  require(valid_owner && valid_acl, "owner-only pipe DACL");
}

void serve(const wchar_t* name, const wchar_t* ready_path) {
  Security security;
  Handle pipe(create_pipe(name, security));
  require(pipe.get() != INVALID_HANDLE_VALUE, "CreateNamedPipe first instance");
  inspect_security(pipe.get());
  Handle duplicate(create_pipe(name, security));
  require(duplicate.get() == INVALID_HANDLE_VALUE && GetLastError() == ERROR_ACCESS_DENIED,
    "first-instance squatting guard");
  {
    Handle ready(CreateFileW(ready_path, GENERIC_WRITE, 0, security.get(), CREATE_NEW, FILE_ATTRIBUTE_NORMAL, nullptr));
    require(ready.get() != INVALID_HANDLE_VALUE, "ready file");
    const auto pid = std::to_string(GetCurrentProcessId());
    DWORD written = 0;
    require(WriteFile(ready.get(), pid.data(), static_cast<DWORD>(pid.size()), &written, nullptr) != FALSE,
      "ready write");
  }
  for (unsigned int attempt = 0; attempt < 8; attempt++) {
    require(ConnectNamedPipe(pipe.get(), nullptr) != FALSE || GetLastError() == ERROR_PIPE_CONNECTED,
      "ConnectNamedPipe");
    ULONG pid = 0;
    require(GetNamedPipeClientProcessId(pipe.get(), &pid) != FALSE, "kernel client PID");
    same_user(pid);
    char command = 0;
    DWORD read = 0;
    const bool received = ReadFile(pipe.get(), &command, 1, &read, nullptr) != FALSE && read == 1;
    if (received) {
      require(command == 'P' || command == 'Q', "bounded probe command");
      DWORD written = 0;
      require(WriteFile(pipe.get(), &command, 1, &written, nullptr) != FALSE && written == 1, "response");
      require(FlushFileBuffers(pipe.get()) != FALSE, "flush response");
    }
    require(DisconnectNamedPipe(pipe.get()) != FALSE, "disconnect");
    if (received && command == 'Q') {
      std::cout << "{\"ownerDacl\":true,\"firstInstanceGuard\":true,\"kernelClientIdentity\":true,\"remoteRejectionConfigured\":true}\n";
      return;
    }
  }
  throw std::runtime_error("Probe connection budget exhausted");
}

void client(const wchar_t* name, DWORD expected, bool denied, bool stop, bool wrong_pid) {
  Handle pipe(CreateFileW(name, GENERIC_READ | GENERIC_WRITE | READ_CONTROL,
    0, nullptr, OPEN_EXISTING, SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION, nullptr));
  const DWORD opened = GetLastError();
  if (denied) {
    require(pipe.get() == INVALID_HANDLE_VALUE && opened == ERROR_ACCESS_DENIED, "cross-account denial");
    std::cout << "{\"crossAccountDenied\":true}\n";
    return;
  }
  require(pipe.get() != INVALID_HANDLE_VALUE, "client open");
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
  const char command = stop ? 'Q' : 'P';
  DWORD written = 0;
  require(WriteFile(pipe.get(), &command, 1, &written, nullptr) != FALSE && written == 1, "request");
  char reply = 0;
  DWORD read = 0;
  require(ReadFile(pipe.get(), &reply, 1, &read, nullptr) != FALSE && read == 1 && reply == command, "reply");
  std::cout << "{\"kernelServerIdentity\":true,\"ownerDacl\":true,\"roundTrip\":true}\n";
}

int wmain(int argc, wchar_t** argv) {
  try {
    if (argc < 4 || std::wstring(argv[2]).find(L"\\\\.\\pipe\\metawork-p0-") != 0)
      throw std::runtime_error("Explicit P0 pipe and mode arguments required");
    const std::wstring mode(argv[1]);
    if (mode == L"serve") serve(argv[2], argv[3]);
    else if (mode == L"client" || mode == L"stop" || mode == L"denied" || mode == L"wrong-pid")
      client(argv[2], std::stoul(argv[3]), mode == L"denied", mode == L"stop", mode == L"wrong-pid");
    else throw std::runtime_error("Unknown probe mode");
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
