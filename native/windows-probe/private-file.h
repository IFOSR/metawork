// P0 handle-based file validation. Not a production credential-store adapter.
#pragma once
#include <memory>

bool trusted_sid(PSID sid, const std::vector<BYTE>& own) {
  return EqualSid(sid, const_cast<BYTE*>(own.data())) != FALSE
    || IsWellKnownSid(sid, WinLocalSystemSid) != FALSE
    || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != FALSE;
}

void inspect_private_file(HANDLE file, bool directory) {
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  require(GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) != FALSE,
    "file attributes");
  require(!(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT), "reparse point refused");
  require(!!(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory, "file kind");
  BY_HANDLE_FILE_INFORMATION information{};
  require(GetFileInformationByHandle(file, &information) != FALSE, "file information");
  if (!directory) require(information.nNumberOfLinks == 1, "hard links refused");
  PSID owner = nullptr;
  PACL acl = nullptr;
  PSECURITY_DESCRIPTOR descriptor = nullptr;
  const DWORD result = GetSecurityInfo(file, SE_FILE_OBJECT,
    OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, &owner, nullptr, &acl, nullptr, &descriptor);
  require(result == ERROR_SUCCESS, "file security information");
  auto own = process_user(GetCurrentProcess());
  bool valid = owner && EqualSid(owner, own.data()) && acl && acl->AceCount > 0;
  if (valid) {
    for (DWORD index = 0; index < acl->AceCount; index++) {
      void* raw = nullptr;
      if (!GetAce(acl, index, &raw)) { valid = false; break; }
      auto header = static_cast<ACE_HEADER*>(raw);
      if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
      if (header->AceType != ACCESS_ALLOWED_ACE_TYPE
        || !trusted_sid(&static_cast<ACCESS_ALLOWED_ACE*>(raw)->SidStart, own)) { valid = false; break; }
    }
  }
  LocalFree(descriptor);
  require(valid, "private file owner or ACL");
}

std::wstring final_path(HANDLE handle) {
  std::vector<wchar_t> buffer(32768);
  const DWORD size = GetFinalPathNameByHandleW(handle, buffer.data(), static_cast<DWORD>(buffer.size()), FILE_NAME_NORMALIZED);
  require(size > 0 && size < buffer.size(), "canonical file path");
  return std::wstring(buffer.data(), size);
}

std::vector<BYTE> read_private_file(const std::wstring& root, const std::wstring& relative_path) {
  require(root.size() > 3 && root[1] == L':' && root[2] == L'\\'
    && root.find(L'/') == std::wstring::npos && root.find(L'\0') == std::wstring::npos,
    "absolute local root required");
  require(!relative_path.empty() && relative_path.find_first_of(L"/:\0", 0, 3) == std::wstring::npos,
    "relative file path required");
  std::vector<std::unique_ptr<Handle>> directories;
  auto open_directory = [&](const std::wstring& path) {
    auto handle = std::make_unique<Handle>(CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(handle->get() != INVALID_HANDLE_VALUE, "open private directory");
    inspect_private_file(handle->get(), true);
    require(_wcsicmp(final_path(handle->get()).c_str(), (L"\\\\?\\" + path).c_str()) == 0,
      "directory path redirection refused");
    directories.push_back(std::move(handle));
  };
  open_directory(root);
  std::wstring path = root;
  size_t offset = 0;
  for (;;) {
    const size_t separator = relative_path.find(L'\\', offset);
    const auto part = relative_path.substr(offset, separator == std::wstring::npos ? separator : separator - offset);
    require(!part.empty() && part != L"." && part != L".." && part.back() != L'.' && part.back() != L' ',
      "unsafe file path segment");
    path += L"\\" + part;
    if (separator == std::wstring::npos) break;
    open_directory(path);
    offset = separator + 1;
  }
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(file.get() != INVALID_HANDLE_VALUE, "open private file");
  inspect_private_file(file.get(), false);
  require(_wcsicmp(final_path(file.get()).c_str(), (L"\\\\?\\" + path).c_str()) == 0,
    "file path redirection refused");
  LARGE_INTEGER size{};
  require(GetFileSizeEx(file.get(), &size) != FALSE && size.QuadPart >= 0 && size.QuadPart <= 65536,
    "bounded private file size");
  std::vector<BYTE> data(static_cast<size_t>(size.QuadPart));
  DWORD read = 0;
  require(ReadFile(file.get(), data.data(), static_cast<DWORD>(data.size()), &read, nullptr) != FALSE
    && read == data.size(), "private file read");
  return data;
}
