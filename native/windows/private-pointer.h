#pragma once

// Atomic replacement of an intentional release/configuration symlink. Reparse
// ancestors and junctions remain forbidden, and the target must stay in root.
void replace_private_symlink(const std::wstring& root, const std::wstring& relative,
    const std::wstring& target, bool directory) {
  assert_local_path(root);
  require(!relative.empty() && relative.front() != L'\\'
    && relative.find_first_of(L"/:\0", 0, 3) == std::wstring::npos, "relative pointer required");
  const auto destination = root + L"\\" + relative;
  assert_local_path(destination);
  const auto parent = destination.substr(0, destination.rfind(L'\\'));
  require(!target.empty() && target.front() != L'\\'
    && target.find_first_of(L"/:\0", 0, 3) == std::wstring::npos, "relative pointer target required");
  std::vector<wchar_t> resolved(32768);
  const DWORD length = GetFullPathNameW((parent + L"\\" + target).c_str(), static_cast<DWORD>(resolved.size()), resolved.data(), nullptr);
  require(length > 0 && length < resolved.size(), "pointer target path");
  const std::wstring target_path(resolved.data(), length);
  assert_local_path(target_path);
  require(target_path.size() > root.size() + 1 && target_path[root.size()] == L'\\'
    && _wcsnicmp(target_path.c_str(), root.c_str(), root.size()) == 0, "pointer target escapes private root");

  std::vector<std::unique_ptr<Handle>> parents;
  for (size_t end = destination.find(L'\\', 3); end != std::wstring::npos; end = destination.find(L'\\', end + 1))
    parents.push_back(pin_directory(destination.substr(0, end), end >= root.size()));
  for (size_t end = target_path.find(L'\\', root.size() + 1); end != std::wstring::npos; end = target_path.find(L'\\', end + 1))
    parents.push_back(pin_directory(target_path.substr(0, end), true));
  Handle pointed(CreateFileW(target_path.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
    nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  require(pointed.get() != INVALID_HANDLE_VALUE, "open pointer target");
  inspect_private_file(pointed.get(), directory);
  {
    Handle existing(CreateFileW(destination.c_str(), READ_CONTROL | FILE_READ_ATTRIBUTES,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
    if (existing.get() == INVALID_HANDLE_VALUE) require(GetLastError() == ERROR_FILE_NOT_FOUND, "inspect replaced pointer");
    else {
      FILE_ATTRIBUTE_TAG_INFO tag{};
      require(GetFileInformationByHandleEx(existing.get(), FileAttributeTagInfo, &tag, sizeof(tag)) != FALSE
        && tag.ReparseTag == IO_REPARSE_TAG_SYMLINK, "only a symbolic link may be replaced");
      inspect_private_file(existing.get(), directory, false, true);
    }
  }
  BYTE random[24];
  require(BCryptGenRandom(nullptr, random, sizeof(random), BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0, "pointer temporary identity");
  std::wstring suffix;
  for (const auto value : random) { suffix += L"0123456789abcdef"[value >> 4]; suffix += L"0123456789abcdef"[value & 15]; }
  const auto temporary = parent + L"\\.metawork-link-" + suffix;
  require(CreateSymbolicLinkW(temporary.c_str(), target.c_str(), SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE
    | (directory ? SYMBOLIC_LINK_FLAG_DIRECTORY : 0)) != FALSE, "create private relative symlink");
  Handle link(CreateFileW(temporary.c_str(), DELETE | READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS, nullptr));
  if (link.get() == INVALID_HANDLE_VALUE) {
    if (directory) RemoveDirectoryW(temporary.c_str()); else DeleteFileW(temporary.c_str());
    require(false, "open private symlink");
  }
  bool replaced = false;
  try {
    inspect_private_file(link.get(), directory, false, true);
    std::vector<BYTE> storage(sizeof(FILE_RENAME_INFO) + destination.size() * sizeof(wchar_t));
    auto rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
    rename->Flags = FILE_RENAME_FLAG_REPLACE_IF_EXISTS | FILE_RENAME_FLAG_POSIX_SEMANTICS;
    rename->RootDirectory = nullptr;
    rename->FileNameLength = static_cast<DWORD>(destination.size() * sizeof(wchar_t));
    std::memcpy(rename->FileName, destination.data(), rename->FileNameLength);
    require(SetFileInformationByHandle(link.get(), FileRenameInfoEx, rename, static_cast<DWORD>(storage.size())) != FALSE,
      "atomic private pointer replacement");
    replaced = true;
    flush_private_path(parent, true);
  } catch (...) {
    if (!replaced) {
      FILE_DISPOSITION_INFO disposition{ TRUE };
      SetFileInformationByHandle(link.get(), FileDispositionInfo, &disposition, sizeof(disposition));
    }
    throw;
  }
}
