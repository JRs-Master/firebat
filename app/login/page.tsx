'use client';
import { useState } from 'react';
import { alertDialog } from '../admin/components/Dialog';

export default function Login() {
  const [id, setId] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, password }) });
    if (res.ok) { window.location.href = '/admin'; }
    else { await alertDialog({ title: 'Login failed', message: 'Invalid credentials', danger: true }); }
  };

  return (
    <div className="h-dvh flex items-center justify-center bg-[#fafafa] px-4 font-sans tracking-tight overflow-hidden">
      <div className="w-full max-w-[400px] bg-white border border-[#eaeaea] rounded-xl shadow-sm p-8">
        <div className="mb-8 text-center">
          <h2 className="text-2xl font-bold text-black mb-1">Log in to Firebat</h2>
          <p className="text-sm text-gray-500">Enter your admin credentials to continue</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 block">Username</label>
            <input type="text" value={id} onChange={(e) => setId(e.target.value)}
              className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors" />
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-700 block">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full border border-[#eaeaea] rounded-md px-3 py-2 text-sm focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-colors" />
          </div>
          <div className="pt-2">
            <button type="submit" className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium h-10 rounded-md text-sm transition-colors flex items-center justify-center shadow-sm">
              Continue
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
