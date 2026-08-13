# apply_patch Command

The `apply_patch` command is a utility that parses and applies GPT-style patch format used by some AI models (particularly OpenAI's GPT models) when they want to make file modifications.

## Installation

The `apply_patch` command is automatically installed to `~/.codeify/agent/bin/` when you first run Codeify CLI. Since this directory is added to your PATH by the shell environment, the command is available in any bash session started by Codeify tools.

## Patch Format

The GPT patch format supports three operations:

### Add File

Creates a new file with the specified content:

```
*** Begin Patch
*** Add File: path/to/new_file.py
+def hello():
+    print("Hello, world!")
*** End Patch
```

### Update File

Updates an existing file by replacing old content with new content. Lines without a prefix are context lines that appear in both the old and new versions:

```
*** Begin Patch
*** Update File: path/to/file.py
@@
-def old_function():
-    print("Old")
+def new_function():
+    print("New")
    return True
*** End Patch
```

Context lines (without `-` or `+` prefix) are included in both the search pattern and the replacement, ensuring the patch matches the correct location in the file.

### Delete File

Removes a file:

```
*** Begin Patch
*** Delete File: path/to/old_file.py
*** End Patch
```

### Multiple Operations

A single patch can contain multiple operations:

```
*** Begin Patch
*** Add File: new_file.py
+content here
*** Update File: existing_file.py
@@
-old line
+new line
*** Delete File: old_file.py
*** End Patch
```

## Usage

The command reads patch data from stdin:

```bash
apply_patch <<'PATCH'
*** Begin Patch
*** Update File: example.py
@@
-old_code = True
+new_code = True
*** End Patch
PATCH
```

## Exit Codes

- `0`: All operations succeeded
- `1`: One or more operations failed (detailed error messages are printed to stderr)

## Error Handling

The command will fail with an error message if:

- File to update doesn't exist
- File to add already exists
- File to delete doesn't exist
- Old text pattern not found in file (for updates)
- File I/O errors occur

## Implementation

The command consists of:

- `apply_patch` - Bash wrapper script
- `apply_patch.py` - Python implementation (requires Python 3)

Both files are installed to `~/.codeify/agent/bin/` and the bash script invokes the Python script.

## Why This Exists

Some AI models (particularly GPT models) prefer to use their own patch format instead of the standard unified diff format or the edit tool. This command allows those models to work seamlessly with Codeify CLI by providing a compatible patch application utility in the shell environment.
