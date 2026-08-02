import type { ReactNode } from 'react';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { Home } from './pages/Home';
import { Playground } from './pages/Playground';
import { Ledger } from './pages/Ledger';
import { Ops } from './pages/Ops';

function NotFound(): ReactNode {
  return (
    <div className="py-10">
      <h1 className="font-serif text-2xl font-semibold">Page not found</h1>
      <p className="mt-2 text-ink-60">
        That route doesn&rsquo;t exist.{' '}
        <a className="link" href="/">
          Back to the overview.
        </a>
      </p>
    </div>
  );
}

const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <Home /> },
      { path: 'play', element: <Playground /> },
      { path: 'ledger', element: <Ledger /> },
      { path: 'ops', element: <Ops /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

export function App(): ReactNode {
  return <RouterProvider router={router} />;
}
