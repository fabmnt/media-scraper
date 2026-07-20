import { useState, type ChangeEvent, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  MAX_UPLOAD_FILE_COUNT,
  SUPPORTED_PLATFORMS,
  type Platform,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';

function formatFileSize(bytes: number) {
  const kibibyte = 1024;
  const mebibyte = kibibyte * kibibyte;
  return bytes >= mebibyte
    ? `${(bytes / mebibyte).toFixed(1)} MiB`
    : `${Math.ceil(bytes / kibibyte)} KiB`;
}

export function MediaUploadForm() {
  const [files, setFiles] = useState<File[]>([]);
  const [platform, setPlatform] = useState<Platform | ''>('');
  const [username, setUsername] = useState('');
  const [selectionMessage, setSelectionMessage] = useState('');
  const queryClient = useQueryClient();
  const upload = useMutation({
    mutationFn: api.uploadMedia,
    onSuccess: async () => {
      setFiles([]);
      setPlatform('');
      setUsername('');
      setSelectionMessage('Upload complete. Your gallery is ready.');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.allMedia }),
        queryClient.invalidateQueries({ queryKey: queryKeys.collections }),
      ]);
    },
  });
  const totalBytes = files.reduce((total, file) => total + file.size, 0);

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    const nextFiles = [...files, ...selectedFiles].slice(
      0,
      MAX_UPLOAD_FILE_COUNT,
    );
    setFiles(nextFiles);
    setSelectionMessage(
      selectedFiles.length + files.length > MAX_UPLOAD_FILE_COUNT
        ? `Only the first ${String(MAX_UPLOAD_FILE_COUNT)} files can be uploaded together.`
        : '',
    );
    event.target.value = '';
  }

  function removeFile(index: number) {
    setFiles((current) =>
      current.filter((_, fileIndex) => fileIndex !== index),
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (files.length === 0) return;
    setSelectionMessage('');
    const normalizedUsername = username.trim();
    upload.mutate({
      files,
      ...(platform ? { platform } : {}),
      ...(normalizedUsername ? { username: normalizedUsername } : {}),
    });
  }

  return (
    <section className="media-upload">
      <div className="media-upload-heading">
        <div>
          <span className="eyebrow">UPLOAD MEDIA</span>
          <h2>Add a gallery from your device</h2>
          <p>
            Upload images, GIFs, and videos as one gallery. A username and
            platform are optional.
          </p>
        </div>
        <form onSubmit={submit}>
          <select
            aria-label="Upload platform"
            onChange={(event) =>
              setPlatform(event.target.value as Platform | '')
            }
            value={platform}
          >
            <option value="">No platform</option>
            {SUPPORTED_PLATFORMS.map((item) => (
              <option key={item} value={item}>
                {item[0]?.toUpperCase()}
                {item.slice(1)}
              </option>
            ))}
          </select>
          <input
            aria-label="Upload username"
            autoComplete="off"
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Username (optional)"
            value={username}
          />
          <label className="file-button">
            Choose files
            <input
              accept="image/*,video/*"
              multiple
              onChange={selectFiles}
              type="file"
            />
          </label>
          <button
            disabled={files.length === 0 || upload.isPending}
            type="submit"
          >
            {upload.isPending
              ? 'Uploading…'
              : `Upload ${String(files.length)} files`}
          </button>
        </form>
      </div>

      {files.length > 0 && (
        <div className="upload-file-list">
          <div className="upload-file-summary">
            <span>
              {String(files.length)} of {String(MAX_UPLOAD_FILE_COUNT)} files
            </span>
            <span>{formatFileSize(totalBytes)}</span>
          </div>
          {files.map((file, index) => (
            <div className="upload-file" key={`${file.name}-${String(index)}`}>
              <span title={file.name}>{file.name}</span>
              <span>{formatFileSize(file.size)}</span>
              <button
                aria-label={`Remove ${file.name}`}
                disabled={upload.isPending}
                onClick={() => removeFile(index)}
                type="button"
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
      {selectionMessage && <p className="queue-success">{selectionMessage}</p>}
      {upload.error && <p className="error">{upload.error.message}</p>}
    </section>
  );
}
