import { createContext, useContext, type ReactNode } from 'react';
import type { Session } from '@kovan/shared';
import { openBranchFile, openFile } from './services/editor';

type Opener = (path: string, line?: number) => void;

const Context = createContext<Opener>((path, line) => void openFile(path, line));

/** How a file named in a lane or a message opens: from this checkout, or from a branch. */
export const useFileOpener = (): Opener => useContext(Context);

/**
 * Inside a session that runs on a registered machine, its files are on that machine, not in
 * this checkout: they open read-only from the session's branch on the remote.
 */
export function SessionFiles({ session, children }: { session: Session; children: ReactNode }) {
  const parent = useContext(Context);
  const opener: Opener =
    session.machine && session.branch
      ? (path, line) =>
          openBranchFile(
            {
              workspaceId: session.workspaceId,
              branch: session.branch!,
              where: session.machine!.name,
            },
            path,
            line,
          )
      : parent;
  return <Context.Provider value={opener}>{children}</Context.Provider>;
}
