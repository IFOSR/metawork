// Bounded handle-based reads shared by the platform adapter and native probes.
#pragma once
#include <memory>

class PrivateFileNotFound : public std::runtime_error {
 public:
  PrivateFileNotFound() : std::runtime_error("Private file does not exist") {}
};

bool trusted_sid(PSID sid, const std::vector<BYTE>& own) {
  return EqualSid(sid, const_cast<BYTE*>(own.data())) != FALSE
    || IsWellKnownSid(sid, WinLocalSystemSid) != FALSE
    || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != FALSE;
}

void inspect_private_file(HANDLE file, bool directory, bool allow_unlinked = false, bool allow_symlink = false) {
  require(GetFileType(file) == FILE_TYPE_DISK, "ordinary disk file required");
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  require(GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) != FALSE,
    "file attributes");
  require(!(attributes.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)
    || (allow_symlink && attributes.ReparseTag == IO_REPARSE_TAG_SYMLINK), "reparse point refused");
  require(!!(attributes.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) == directory, "file kind");
  BY_HANDLE_FILE_INFORMATION information{};
  require(GetFileInformationByHandle(file, &information) != FALSE, "file information");
  if (!directory) require(information.nNumberOfLinks == 1
    || (allow_unlinked && information.nNumberOfLinks == 0), "hard links refused");
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

std::wstring long_path(const std::wstring& path) {
  // Hosted Windows TEMP may contain an 8.3 username. Expand lexical aliases
  // before comparison without accepting a different reparse target path.
  std::vector<wchar_t> buffer(32768);
  const DWORD size = GetLongPathNameW(path.c_str(), buffer.data(), static_cast<DWORD>(buffer.size()));
  require(size > 0 && size < buffer.size(), "long file path");
  return L"\\\\?\\" + std::wstring(buffer.data(), size);
}

void assert_local_path(const std::wstring& path) {
  require(path.size() > 3 && path[1] == L':' && path[2] == L'\\'
    && path.find_first_of(L"/\0", 0, 2) == std::wstring::npos && path.find(L':', 2) == std::wstring::npos,
    "absolute local path required");
  size_t offset = 3;
  while (offset < path.size()) {
    const auto end = path.find(L'\\', offset);
    const auto part = path.substr(offset, end == std::wstring::npos ? end : end - offset);
    require(!part.empty() && part != L"." && part != L".." && part.back() != L'.' && part.back() != L' ',
      "unsafe private directory segment");
    if (end == std::wstring::npos) return;
    offset = end + 1;
  }
  require(false, "trailing directory separator refused");
}

std::unique_ptr<Handle> pin_directory(const std::wstring& path, bool private_directory) {
  auto handle = std::make_unique<Handle>(CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES
    | (private_directory ? FILE_ADD_FILE | FILE_DELETE_CHILD : 0),
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(handle->get() != INVALID_HANDLE_VALUE, "pin directory");
  FILE_ATTRIBUTE_TAG_INFO info{};
  require(GetFileInformationByHandleEx(handle->get(), FileAttributeTagInfo, &info, sizeof(info)) != FALSE
    && (info.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) && !(info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT),
    "ordinary directory required");
  require(_wcsicmp(final_path(handle->get()).c_str(), long_path(path).c_str()) == 0, "directory redirection refused");
  if (private_directory) inspect_private_file(handle->get(), true);
  return handle;
}

std::vector<BYTE> read_private_file(const std::wstring& root, const std::wstring& relative_path, size_t maximum = 65536) {
  require(maximum > 0 && maximum <= 9 * 1024 * 1024, "bounded private read limit");
  assert_local_path(root);
  require(!relative_path.empty() && relative_path.find_first_of(L"/:\0", 0, 3) == std::wstring::npos,
    "relative file path required");
  std::vector<std::unique_ptr<Handle>> directories;
  auto open_directory = [&](const std::wstring& path) {
    auto handle = std::make_unique<Handle>(CreateFileW(path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    require(handle->get() != INVALID_HANDLE_VALUE, "open private directory");
    inspect_private_file(handle->get(), true);
    require(_wcsicmp(final_path(handle->get()).c_str(), long_path(path).c_str()) == 0,
      "directory path redirection refused");
    directories.push_back(std::move(handle));
  };
  for (size_t end = root.find(L'\\', 3); end != std::wstring::npos; end = root.find(L'\\', end + 1))
    directories.push_back(pin_directory(root.substr(0, end), false));
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
  Handle file(CreateFileW(path.c_str(), GENERIC_READ | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_DELETE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  // Only a missing final file is an empty-store case. Missing/unsafe ancestors,
  // ACL denial and malformed paths must never become a new empty credential store.
  if (file.get() == INVALID_HANDLE_VALUE && GetLastError() == ERROR_FILE_NOT_FOUND) throw PrivateFileNotFound();
  require(file.get() != INVALID_HANDLE_VALUE, "open private file");
  // Every ancestor is already pinned and non-reparse, and this final open uses
  // OPEN_REPARSE_POINT. Validate the opened inode, not its later pathname:
  // POSIX replacement can unlink/rename that inode while a reader retains it.
  inspect_private_file(file.get(), false, true);
  LARGE_INTEGER size{};
  require(GetFileSizeEx(file.get(), &size) != FALSE && size.QuadPart >= 0 && static_cast<ULONGLONG>(size.QuadPart) <= maximum,
    "bounded private file size");
  std::vector<BYTE> data(static_cast<size_t>(size.QuadPart));
  DWORD read = 0;
  require(ReadFile(file.get(), data.data(), static_cast<DWORD>(data.size()), &read, nullptr) != FALSE
    && read == data.size(), "private file read");
  return data;
}
