{
  "targets": [{
    "target_name": "metawork_platform",
    "sources": ["platform.cpp"],
    "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX", "_WIN32_WINNT=0x0A00"],
    "libraries": ["advapi32.lib", "bcrypt.lib"],
    "msvs_settings": {
      "VCCLCompilerTool": {
        "ExceptionHandling": 1,
        "RuntimeLibrary": 0,
        "AdditionalOptions": ["/std:c++17", "/W4", "/WX"]
      }
    }
  }]
}
