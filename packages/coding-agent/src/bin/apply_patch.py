#!/usr/bin/env python3
"""
Apply GPT-style patches to files.

Parses patch format:
*** Begin Patch
*** Add File: path/to/file.py
+ line 1
+ line 2
*** Update File: path/to/file.py
@@
- old line 1
- old line 2
+ new line 1
+ new line 2
*** Delete File: path/to/file.py
*** End Patch
"""

import sys
import re
from pathlib import Path
from typing import List, Tuple, Optional, Literal

OperationType = Literal['add', 'update', 'delete']

def parse_patch(patch_text: str) -> List[Tuple[OperationType, str, List[Tuple[str, str]]]]:
    """
    Parse GPT patch format into structured data.
    
    Returns: List of (operation, filename, [(old_text, new_text)])
    """
    files = []
    current_file = None
    current_operation = None
    current_old = []
    current_new = []
    in_patch = False
    
    lines = patch_text.strip().split('\n')
    
    for line in lines:
        if line.strip() == '*** Begin Patch':
            in_patch = True
            continue
        elif line.strip() == '*** End Patch':
            if current_file and current_operation:
                if current_operation == 'delete':
                    files.append((current_operation, current_file, []))
                elif current_old or current_new:
                    old_text = '\n'.join(current_old)
                    new_text = '\n'.join(current_new)
                    if files and files[-1][1] == current_file and files[-1][0] == current_operation:
                        files[-1][2].append((old_text, new_text))
                    else:
                        files.append((current_operation, current_file, [(old_text, new_text)]))
            break
        
        if not in_patch:
            continue
        
        if line.startswith('*** Add File: '):
            if current_file and current_operation:
                if current_operation == 'delete':
                    files.append((current_operation, current_file, []))
                elif current_old or current_new:
                    old_text = '\n'.join(current_old)
                    new_text = '\n'.join(current_new)
                    if files and files[-1][1] == current_file and files[-1][0] == current_operation:
                        files[-1][2].append((old_text, new_text))
                    else:
                        files.append((current_operation, current_file, [(old_text, new_text)]))
            
            current_file = line[len('*** Add File: '):].strip()
            current_operation = 'add'
            current_old = []
            current_new = []
            continue
            
        if line.startswith('*** Update File: '):
            if current_file and current_operation:
                if current_operation == 'delete':
                    files.append((current_operation, current_file, []))
                elif current_old or current_new:
                    old_text = '\n'.join(current_old)
                    new_text = '\n'.join(current_new)
                    if files and files[-1][1] == current_file and files[-1][0] == current_operation:
                        files[-1][2].append((old_text, new_text))
                    else:
                        files.append((current_operation, current_file, [(old_text, new_text)]))
            
            current_file = line[len('*** Update File: '):].strip()
            current_operation = 'update'
            current_old = []
            current_new = []
            continue
        
        if line.startswith('*** Delete File: '):
            if current_file and current_operation:
                if current_operation == 'delete':
                    files.append((current_operation, current_file, []))
                elif current_old or current_new:
                    old_text = '\n'.join(current_old)
                    new_text = '\n'.join(current_new)
                    if files and files[-1][1] == current_file and files[-1][0] == current_operation:
                        files[-1][2].append((old_text, new_text))
                    else:
                        files.append((current_operation, current_file, [(old_text, new_text)]))
            
            current_file = line[len('*** Delete File: '):].strip()
            current_operation = 'delete'
            current_old = []
            current_new = []
            continue
        
        if line.strip() == '@@':
            if current_file and current_operation and (current_old or current_new):
                old_text = '\n'.join(current_old)
                new_text = '\n'.join(current_new)
                if files and files[-1][1] == current_file and files[-1][0] == current_operation:
                    files[-1][2].append((old_text, new_text))
                else:
                    files.append((current_operation, current_file, [(old_text, new_text)]))
                current_old = []
                current_new = []
            continue
        
        if line.startswith('-'):
            current_old.append(line[1:])
        elif line.startswith('+'):
            current_new.append(line[1:])
        else:
            current_old.append(line)
            current_new.append(line)
    
    return files

def add_file(filepath: str, content: str) -> bool:
    """
    Create a new file with the given content.
    Returns True if successful, False otherwise.
    """
    path = Path(filepath)
    
    if path.exists():
        print(f"Error: File already exists: {filepath}", file=sys.stderr)
        return False
    
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        print(f"Successfully created {filepath}")
        return True
    except Exception as e:
        print(f"Error creating {filepath}: {e}", file=sys.stderr)
        return False

def delete_file(filepath: str) -> bool:
    """
    Delete a file.
    Returns True if successful, False otherwise.
    """
    path = Path(filepath)
    
    if not path.exists():
        print(f"Error: File not found: {filepath}", file=sys.stderr)
        return False
    
    try:
        path.unlink()
        print(f"Successfully deleted {filepath}")
        return True
    except Exception as e:
        print(f"Error deleting {filepath}: {e}", file=sys.stderr)
        return False

def apply_patch_to_file(filepath: str, edits: List[Tuple[str, str]]) -> bool:
    """
    Apply a list of (old_text, new_text) edits to a file.
    Returns True if successful, False otherwise.
    """
    path = Path(filepath)
    
    if not path.exists():
        print(f"Error: File not found: {filepath}", file=sys.stderr)
        return False
    
    try:
        content = path.read_text()
    except Exception as e:
        print(f"Error reading {filepath}: {e}", file=sys.stderr)
        return False
    
    modified_content = content
    
    for old_text, new_text in edits:
        if not old_text and not new_text:
            continue
        
        if old_text and old_text not in modified_content:
            print(f"Warning: Old text not found in {filepath}:", file=sys.stderr)
            print(f"  Looking for: {repr(old_text[:100])}", file=sys.stderr)
            return False
        
        if old_text:
            modified_content = modified_content.replace(old_text, new_text, 1)
        else:
            modified_content += new_text
    
    if modified_content == content:
        print(f"No changes to {filepath}")
        return True
    
    try:
        path.write_text(modified_content)
        print(f"Successfully patched {filepath}")
        return True
    except Exception as e:
        print(f"Error writing {filepath}: {e}", file=sys.stderr)
        return False

def main():
    if sys.stdin.isatty():
        print("Usage: apply_patch <<'PATCH'", file=sys.stderr)
        print("*** Begin Patch", file=sys.stderr)
        print("*** Add File: path/to/new_file", file=sys.stderr)
        print("+ content", file=sys.stderr)
        print("*** Update File: path/to/file", file=sys.stderr)
        print("@@", file=sys.stderr)
        print("- old text", file=sys.stderr)
        print("+ new text", file=sys.stderr)
        print("*** Delete File: path/to/old_file", file=sys.stderr)
        print("*** End Patch", file=sys.stderr)
        print("PATCH", file=sys.stderr)
        sys.exit(1)
    
    patch_text = sys.stdin.read()
    
    try:
        operations = parse_patch(patch_text)
    except Exception as e:
        print(f"Error parsing patch: {e}", file=sys.stderr)
        sys.exit(1)
    
    if not operations:
        print("Error: No operations found in patch", file=sys.stderr)
        sys.exit(1)
    
    success = True
    for operation, filepath, edits in operations:
        if operation == 'add':
            if edits:
                content = '\n'.join(edit[1] for edit in edits if edit[1])
            else:
                content = ''
            if not add_file(filepath, content):
                success = False
        elif operation == 'delete':
            if not delete_file(filepath):
                success = False
        elif operation == 'update':
            if not edits:
                continue
            if not apply_patch_to_file(filepath, edits):
                success = False
    
    sys.exit(0 if success else 1)

if __name__ == '__main__':
    main()
