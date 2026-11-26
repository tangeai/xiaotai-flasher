import { useLayoutEffect, useRef } from 'react';

export function FirmwareFileInput({ file, onFileChange, ...props }) {
  const inputRef = useRef(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    if ((input.files[0] ?? null) === (file ?? null)) return;
    if (!file) {
      input.value = '';
      return;
    }
    // A remounted file input starts empty even when the workbench retained the File.
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
  }, [file]);

  return <input {...props} ref={inputRef} type="file"
    onChange={event => onFileChange(event.target.files[0] ?? null)} />;
}
