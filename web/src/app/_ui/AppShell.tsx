'use client';

/**
 * The page frame every page shares, in the Nintex platform's look: Textura's MainNav on
 * the left, breadcrumbs in the action-header strip, then the page header and body.
 * Mirrors Tango's and ntx-proc-demo's AppShell so the tools read as one product.
 */

import { ActionHeader, Breadcrumbs, Header, MainNav, PageLayout } from '@exp-textura/react';
import { Archive, ArchiveBoxSolid, Delete, Documents, DocumentsSolid, FolderOpen, Home, HomeSolid, Undo, Users } from '@exp-textura/icons';
import { NintexLogo, NintexLogoSquare } from '@exp-textura/icons/brand';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

const PAGE_CONTENT_ID = 'page-content';

export interface Crumb {
  label: string;
  /** Absent on the current page, which is the last crumb. */
  href?: string;
}

interface AppShellProps {
  title?: ReactNode;
  description?: ReactNode;
  /** Header buttons, trailing the title. */
  actions?: ReactNode;
  /** One row of page state under the title: who is signed in, on which tenant. */
  meta?: ReactNode;
  breadcrumbs?: Crumb[];
  /** Forms read better narrow; plans and tables want the room. */
  pageWidth?: 'default' | 'fullWidth';
  children?: ReactNode;
}

export function AppShell({
  title,
  description,
  actions,
  meta,
  breadcrumbs,
  pageWidth = 'fullWidth',
  children,
}: AppShellProps) {
  return (
    <PageLayout>
      <PageLayout.SkipToContent href={`#${PAGE_CONTENT_ID}`} />
      <PageLayout.MainNav>
        <Sidebar />
      </PageLayout.MainNav>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <PageLayout.ActionHeader>
          <ActionHeader>
            <ActionHeader.Leading>
              <Breadcrumbs>{crumbs(breadcrumbs)}</Breadcrumbs>
            </ActionHeader.Leading>
          </ActionHeader>
        </PageLayout.ActionHeader>
      )}
      <PageLayout.Main id={PAGE_CONTENT_ID} pageWidth={pageWidth}>
        {title !== undefined && (
          <PageLayout.Header>
            <Header>
              <Header.Content>
                <Header.Title>{title}</Header.Title>
                {meta !== undefined && <Header.Meta>{meta}</Header.Meta>}
                {description !== undefined && <Header.Description>{description}</Header.Description>}
              </Header.Content>
              {actions !== undefined && <Header.Actions>{actions}</Header.Actions>}
            </Header>
          </PageLayout.Header>
        )}
        <PageLayout.Body>
          <PageLayout.BodyContent>
            <div className={pageWidth === 'default' ? 'page narrow' : 'page'}>{children}</div>
          </PageLayout.BodyContent>
        </PageLayout.Body>
      </PageLayout.Main>
    </PageLayout>
  );
}

/** Breadcrumbs takes flat children: items and dividers as siblings, no fragments. */
function crumbs(trail: Crumb[]): ReactNode[] {
  return trail.flatMap((crumb, i) => {
    const item = crumb.href ? (
      <Breadcrumbs.Item asChild key={`i${i}`}>
        <Link href={crumb.href}>{crumb.label}</Link>
      </Breadcrumbs.Item>
    ) : (
      <Breadcrumbs.Item key={`i${i}`}>{crumb.label}</Breadcrumbs.Item>
    );
    return i === 0 ? [item] : [<Breadcrumbs.Divider key={`d${i}`} />, item];
  });
}

function Sidebar() {
  const pathname = usePathname();
  const isSection = (path: string) => pathname === path || pathname.startsWith(`${path}/`);

  return (
    <MainNav>
      <MainNav.Header>
        <MainNav.Brand
          aria-label="Bulk Operations home"
          href="/"
          brandImg={<NintexLogo style={{ height: 20, width: 80, display: 'block' }} />}
          squareBrandImg={<NintexLogoSquare style={{ height: 24, width: 24, display: 'block' }} />}
        />
        <MainNav.CollapseTrigger />
      </MainNav.Header>

      <MainNav.Content>
        <MainNav.Item asChild isCurrent={pathname === '/'} icon={<Home />} hoverIcon={<HomeSolid />}>
          <Link href="/">Home</Link>
        </MainNav.Item>

        <MainNav.Divider />

        <MainNav.Item asChild isCurrent={isSection('/archive')} icon={<Archive />} hoverIcon={<ArchiveBoxSolid />}>
          <Link href="/archive">Bulk Archive</Link>
        </MainNav.Item>
        <MainNav.Item asChild isCurrent={isSection('/delete')} icon={<Delete />}>
          <Link href="/delete">Bulk Delete</Link>
        </MainNav.Item>
        <MainNav.Item asChild isCurrent={isSection('/move')} icon={<FolderOpen />}>
          <Link href="/move">Bulk Move</Link>
        </MainNav.Item>
        <MainNav.Item asChild isCurrent={isSection('/ownership')} icon={<Users />}>
          <Link href="/ownership">Bulk Update Ownership</Link>
        </MainNav.Item>

        {/* Documents are their own section (W8 decision 2); a page joins it as its task lands. */}
        <MainNav.Divider />

        <MainNav.Item asChild isCurrent={isSection('/documents/archive')} icon={<Documents />} hoverIcon={<DocumentsSolid />}>
          <Link href="/documents/archive">Archive documents</Link>
        </MainNav.Item>
        <MainNav.Item asChild isCurrent={isSection('/documents/delete')} icon={<Delete />}>
          <Link href="/documents/delete">Delete documents</Link>
        </MainNav.Item>
        <MainNav.Item asChild isCurrent={isSection('/documents/restore')} icon={<Undo />}>
          <Link href="/documents/restore">Restore documents</Link>
        </MainNav.Item>
      </MainNav.Content>
    </MainNav>
  );
}
