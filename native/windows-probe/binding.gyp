{
  "targets": [{
    "target_name": "metawork_windows_probe",
    "sources": ["node-probe.cpp"],
    "defines": ["NAPI_VERSION=8", "UNICODE", "_UNICODE", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
    "libraries": ["advapi32.lib"],
    "msvs_settings": {
      "VCCLCompilerTool": {
        "ExceptionHandling": 1,
        "RuntimeLibrary": 0,
        "AdditionalOptions": ["/std:c++17", "/W4", "/WX"]
      }
    }
  }]
}
