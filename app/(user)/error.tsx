'use client';

/**
 * User 영역 error boundary — throw 박힌 영역 안 client-side redirect to /500.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export default function Error({
  error: _error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  useEffect(() => {
    router.replace('/500');
  }, [router]);
  return null;
}
