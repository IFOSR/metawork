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
    const bool created = CreateDirectoryW(native_path(current).c_str(), security.get()) != FALSE;
    require(created || GetLastError() == ERROR_ALREADY_EXISTS, "create private directory");
    parents.push_back(pin_directory(current, created || end == std::wstring::npos));
    if (end == std::wstring::npos) break;
    offset = end + 1;
  }
}

void flush_private_path(const std::wstring& path, bool directory) {
  assert_local_path(path);
  std::vector<std::unique_ptr<Handle>> parents;
  for (size_t end = path.find(L'\\', 3); end != std::wstring::npos; end = path.find(L'\\', end + 1))
    parents.push_back(pin_directory(path.substr(0, end), false));
  // FlushFileBuffers needs GENERIC_WRITE even for an NTFS directory. Node's
  // read-only fsync handles cannot provide this Windows durability primitive.
  Handle file(CreateFileW(native_path(path).c_str(), GENERIC_WRITE | READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr));
  require(file.get() != INVALID_HANDLE_VALUE, "open private flush handle");
  inspect_private_file(file.get(), directory);
  require(FlushFileBuffers(file.get()) != FALSE, "flush private path");
}

void remove_private_file(const std::wstring& root, const std::wstring& relative) {
  assert_local_path(root);
  require(!relative.empty() && relative.front() != L'\\'
    && relative.find_first_of(L"/:\0", 0, 3) == std::wstring::npos, "relative private file required");
  const auto path = root + L"\\" + relative;
  assert_local_path(path);
  std::vector<std::unique_ptr<Handle>> parents;
  for (size_t end = path.find(L'\\', 3); end != std::wstring::npos; end = path.find(L'\\', end + 1))
    parents.push_back(pin_directory(path.substr(0, end), end >= root.size()));
  Handle file(CreateFileW(native_path(path).c_str(), DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (file.get() == INVALID_HANDLE_VALUE && GetLastError() == ERROR_FILE_NOT_FOUND) return;
  require(file.get() != INVALID_HANDLE_VALUE, "open private file for removal");
  inspect_private_file(file.get(), false);
  FILE_DISPOSITION_INFO_EX disposition{ FILE_DISPOSITION_FLAG_DELETE | FILE_DISPOSITION_FLAG_POSIX_SEMANTICS };
  require(SetFileInformationByHandle(file.get(), FileDispositionInfoEx, &disposition, sizeof(disposition)) != FALSE,
    "remove private file");
  flush_private_path(path.substr(0, path.rfind(L'\\')), true);
}

// Publish a completed staging directory or quarantine a regular file without
// replacing a concurrent destination. Both paths remain beneath the same root.
void move_private_entry(const std::wstring& root, const std::wstring& source_relative,
    const std::wstring& destination_relative, bool directory) {
  assert_local_path(root);
  std::vector<std::unique_ptr<Handle>> parents;
  auto guarded_path = [&](const std::wstring& relative) {
    require(!relative.empty() && relative.front() != L'\\'
      && relative.find_first_of(L"/:\0", 0, 3) == std::wstring::npos, "relative private entry required");
    const auto path = root + L"\\" + relative;
    assert_local_path(path);
    for (size_t end = path.find(L'\\', 3); end != std::wstring::npos; end = path.find(L'\\', end + 1))
      parents.push_back(pin_directory(path.substr(0, end), end >= root.size()));
    return path;
  };
  const auto source = guarded_path(source_relative);
  const auto destination = guarded_path(destination_relative);
  Handle file(CreateFileW(native_path(source).c_str(), DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0), nullptr));
  if (file.get() == INVALID_HANDLE_VALUE && GetLastError() == ERROR_FILE_NOT_FOUND) throw PrivateFileNotFound();
  require(file.get() != INVALID_HANDLE_VALUE, "open private entry for move");
  inspect_private_file(file.get(), directory);
  const auto native_destination = native_path(destination);
  std::vector<BYTE> storage(sizeof(FILE_RENAME_INFO) + native_destination.size() * sizeof(wchar_t));
  auto rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
  rename->Flags = 0;
  rename->RootDirectory = nullptr;
  rename->FileNameLength = static_cast<DWORD>(native_destination.size() * sizeof(wchar_t));
  std::memcpy(rename->FileName, native_destination.data(), rename->FileNameLength);
  if (!SetFileInformationByHandle(file.get(), FileRenameInfoEx, rename, static_cast<DWORD>(storage.size()))) {
    const DWORD error = GetLastError();
    if (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS) throw PrivateFileExists();
    require(false, "move private entry");
  }
  flush_private_path(destination.substr(0, destination.rfind(L'\\')), true);
  flush_private_path(source.substr(0, source.rfind(L'\\')), true);
}

void write_private_file(const std::wstring& root, const std::wstring& relative_path, const BYTE* bytes, size_t size, size_t maximum = 65536, bool replace = true) {
  assert_local_path(root);
  require(!relative_path.empty() && relative_path.front() != L'\\'
    && relative_path.find_first_of(L"/:\0", 0, 3) == std::wstring::npos
    && maximum > 0 && maximum <= 9 * 1024 * 1024 && size <= maximum,
    "bounded relative private file required");
  const auto destination = root + L"\\" + relative_path;
  assert_local_path(destination);
  std::vector<std::unique_ptr<Handle>> parents;
  // Pin every ancestor without delete-sharing before using an absolute target,
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
    Handle existing(CreateFileW(native_path(destination).c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (existing.get() == INVALID_HANDLE_VALUE) require(GetLastError() == ERROR_FILE_NOT_FOUND, "inspect replaced file");
    else {
      // Another guarded writer can unlink this inspected inode by atomic
      // replacement. It remains safe to inspect; we never mutate its contents.
      inspect_private_file(existing.get(), false, true);
      if (!replace) throw PrivateFileExists();
    }
  }
  BYTE random[24];
  require(BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, "private temporary identity");
  std::wstring suffix;
  for (const auto value : random) { suffix += L"0123456789abcdef"[value >> 4]; suffix += L"0123456789abcdef"[value & 15]; }
  const auto temporary = destination.substr(0, offset) + L".metawork-write-" + suffix;
  PrivateSecurity security;
  auto file = std::make_unique<Handle>(CreateFileW(native_path(temporary).c_str(), GENERIC_WRITE | DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_DELETE, security.get(), CREATE_NEW,
    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  require(file->get() != INVALID_HANDLE_VALUE, "create private temporary file");
  bool replaced = false;
  try {
    inspect_private_file(file->get(), false);
    DWORD written = 0;
    require(WriteFile(file->get(), bytes, static_cast<DWORD>(size), &written, nullptr) != FALSE && written == size,
      "write private file");
    require(FlushFileBuffers(file->get()) != FALSE, "flush private file");
    const auto target = native_path(destination);
    std::vector<BYTE> storage(sizeof(FILE_RENAME_INFO) + target.size() * sizeof(wchar_t));
    auto rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
    // Windows 11/NTFS: retain open readers on the previous inode while new
    // opens see the replacement. Readers still must allow delete-sharing.
    rename->Flags = replace ? FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS : 0;
    rename->RootDirectory = nullptr;
    rename->FileNameLength = static_cast<DWORD>(target.size() * sizeof(wchar_t));
    std::memcpy(rename->FileName, target.data(), rename->FileNameLength);
    if (!SetFileInformationByHandle(file->get(), FileRenameInfoEx, rename, static_cast<DWORD>(storage.size()))) {
      const DWORD error = GetLastError();
      if (!replace && (error == ERROR_ALREADY_EXISTS || error == ERROR_FILE_EXISTS)) throw PrivateFileExists();
      require(false, "atomic private file replacement");
    }
    replaced = true;
    require(FlushFileBuffers(file->get()) != FALSE, "flush replaced private file");
    flush_private_path(destination.substr(0, offset - 1), true);
  } catch (...) {
    // A post-rename flush failure is an uncertain durable outcome. Preserve the
    // complete replacement for journal recovery; only delete unpublished temps.
    if (!replaced) {
      FILE_DISPOSITION_INFO disposition{ TRUE };
      SetFileInformationByHandle(file->get(), FileDispositionInfo, &disposition, sizeof(disposition));
    }
    throw;
  }
}
