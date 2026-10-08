#pragma once
#include <bcrypt.h>
#include <cstring>

class PrivateSecurity {
 public:
  PrivateSecurity() {
    auto sid = process_user(GetCurrentProcess());
    LPWSTR raw = nullptr;
    require(ConvertSidToStringSidW(sid.data(), &raw) != FALSE, "private SID");
    const std::wstring text(raw); LocalFree(raw);
    const auto sddl = L"O:" + text + L"D:P(A;OICI;FA;;;" + text + L")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1,
      &descriptor_, nullptr) != FALSE, "private security descriptor");
    attributes_ = { sizeof(SECURITY_ATTRIBUTES), descriptor_, FALSE };
  }
  ~PrivateSecurity() { LocalFree(descriptor_); }
  SECURITY_ATTRIBUTES* get() { return &attributes_; }
 private:
  PSECURITY_DESCRIPTOR descriptor_ = nullptr;
  SECURITY_ATTRIBUTES attributes_{};
};

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

void ensure_private_directory(const std::wstring& path) {
  assert_local_path(path);
  PrivateSecurity security;
  std::vector<std::unique_ptr<Handle>> parents;
  size_t offset = 3;
  for (;;) {
    const size_t end = path.find(L'\\', offset);
    const auto current = path.substr(0, end);
    const bool created = CreateDirectoryW(current.c_str(), security.get()) != FALSE;
    require(created || GetLastError() == ERROR_ALREADY_EXISTS, "create private directory");
    parents.push_back(pin_directory(current, created || end == std::wstring::npos));
    if (end == std::wstring::npos) break;
    offset = end + 1;
  }
}

void write_private_file(const std::wstring& root, const std::wstring& relative_path, const BYTE* bytes, size_t size, size_t maximum = 65536) {
  assert_local_path(root);
  require(!relative_path.empty() && relative_path.front() != L'\\'
    && relative_path.find_first_of(L"/:\0", 0, 3) == std::wstring::npos
    && maximum > 0 && maximum <= 9 * 1024 * 1024 && size <= maximum,
    "bounded relative private file required");
  const auto destination = root + L"\\" + relative_path;
  assert_local_path(destination);
  std::vector<std::unique_ptr<Handle>> parents;
  parents.push_back(pin_directory(root, true));
  size_t offset = root.size() + 1;
  for (;;) {
    const auto separator = destination.find(L'\\', offset);
    if (separator == std::wstring::npos) break;
    parents.push_back(pin_directory(destination.substr(0, separator), true));
    offset = separator + 1;
  }
  {
    Handle existing(CreateFileW(destination.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (existing.get() == INVALID_HANDLE_VALUE) require(GetLastError() == ERROR_FILE_NOT_FOUND, "inspect replaced file");
    else inspect_private_file(existing.get(), false);
  }
  BYTE random[24];
  require(BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, "private temporary identity");
  std::wstring suffix;
  for (const auto value : random) { suffix += L"0123456789abcdef"[value >> 4]; suffix += L"0123456789abcdef"[value & 15]; }
  const auto temporary = destination.substr(0, offset) + L".metawork-write-" + suffix;
  PrivateSecurity security;
  auto file = std::make_unique<Handle>(CreateFileW(temporary.c_str(), GENERIC_WRITE | DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
    0, security.get(), CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(file->get() != INVALID_HANDLE_VALUE, "create private temporary file");
  try {
    inspect_private_file(file->get(), false);
    DWORD written = 0;
    require(WriteFile(file->get(), bytes, static_cast<DWORD>(size), &written, nullptr) != FALSE && written == size,
      "write private file");
    require(FlushFileBuffers(file->get()) != FALSE, "flush private file");
    const auto target = destination.substr(offset);
    std::vector<BYTE> storage(sizeof(FILE_RENAME_INFO) + target.size() * sizeof(wchar_t));
    auto rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
    rename->ReplaceIfExists = TRUE;
    rename->RootDirectory = parents.back()->get();
    rename->FileNameLength = static_cast<DWORD>(target.size() * sizeof(wchar_t));
    std::memcpy(rename->FileName, target.data(), rename->FileNameLength);
    require(SetFileInformationByHandle(file->get(), FileRenameInfo, rename, static_cast<DWORD>(storage.size())) != FALSE,
      "atomic private file replacement");
  } catch (...) {
    FILE_DISPOSITION_INFO disposition{ TRUE };
    SetFileInformationByHandle(file->get(), FileDispositionInfo, &disposition, sizeof(disposition));
    throw;
  }
}
