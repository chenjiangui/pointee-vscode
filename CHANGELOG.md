# Changelog

## 0.1.1

- Copy screenshots directly to the system image clipboard by default, without writing image files.
- Add an explicit "Save Element Screenshot" command for PNG files and path-based agent workflows.
- Use native macOS/Windows clipboard tools and wl-clipboard/xclip on Linux.
- Fall back to a saved PNG and copied path if image copying fails, with an explicit warning.
- Show accurate copied/saved feedback in the in-page toolbar.
- Cover native PNG clipboard readback, image paste, no-file behavior, and fallback paths in tests.
- Add repository metadata and an explicit Marketplace publishing command that allows only the browser API proposal.
- Use the Marketplace publisher ID pointee-vscode and update launch, development, and integration-test identifiers accordingly.

## 0.1.0

- Initial VS Code integrated-browser port of Pointee.
