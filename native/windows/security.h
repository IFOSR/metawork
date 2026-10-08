// Shared Win32 identity/security primitives; no product policy or Node private APIs.
#pragma once
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

