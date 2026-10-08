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
  // SetFileInformationByHandle requires RootDirectory == nullptr. Pin every
  // ancestor without delete-sharing before using an absolute rename target,
  // so a concurrent directory rename/reparse swap cannot redirect that path.
  for (size_t end = root.find(L'\\', 3); end != std::wstring::npos; end = root.find(L'\\', end + 1))
    parents.push_back(pin_directory(root.substr(0, end), false));
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
    const auto target = destination;
    std::vector<BYTE> storage(sizeof(FILE_RENAME_INFO) + target.size() * sizeof(wchar_t));
    auto rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
    rename->ReplaceIfExists = TRUE;
    rename->RootDirectory = nullptr;
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
