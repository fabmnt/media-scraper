import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys } from '../query-keys';

export function CollectionForm() {
  const [url, setUrl] = useState('');
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: api.createCollection,
    onSuccess: async () => {
      setUrl('');
      await queryClient.invalidateQueries({ queryKey: queryKeys.collections });
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    mutation.mutate({ url });
  }

  return (
    <section className="collector">
      <div>
        <span className="eyebrow">COLLECT SOMETHING</span>
        <h2>Paste a public post or gallery URL</h2>
        <p>Instagram, Facebook, and TikTok are supported in this version.</p>
      </div>
      <form onSubmit={submit}>
        <input
          aria-label="Media URL"
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://www.instagram.com/p/..."
          required
          type="url"
          value={url}
        />
        <button disabled={mutation.isPending} type="submit">
          {mutation.isPending ? 'Queuing…' : 'Collect media'}
        </button>
      </form>
      {mutation.error && <p className="error">{mutation.error.message}</p>}
    </section>
  );
}
