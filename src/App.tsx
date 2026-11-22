import { useState, useEffect, useMemo, useRef } from 'react';
import { Toaster, toast } from 'sonner';
import { PanelBottomOpen } from 'lucide-react';
import Header from './components/Header';
import ChatThread from './components/ChatThread';
import Composer from './components/Composer';
import SettingsSheet from './components/SettingsSheet';
import MemoriesSheet from './components/MemoriesSheet';
import ConversationList from './components/ConversationList';
import FolderPicker from './components/FolderPicker';
import FolderDeleteSheet from './components/FolderDeleteSheet';
import ReasoningPicker, { labelFor } from './components/ReasoningPicker';
import Unreachable from './components/Unreachable';
import useServerState from './hooks/useServerState';
import { chatMarkdown, downloadText, exportFileName } from './lib/export';
import useModelConfig from './hooks/useModelConfig';
import useReplyStyle from './hooks/useReplyStyle';
import useWakeLock from './hooks/useWakeLock';
import useMediaQuery, { WIDE } from './hooks/useMediaQuery';
import useChromeHeights from './hooks/useChromeHeights';
import { edgeSwipe } from './lib/edgeSwipe';
import type { Folder } from './types';
import './App.css';

export default function App() {
  const server = useServerState();
  const {
    conversations, activeId, active, loadingActive, config, status, startedAt, busy, working,
    send, stop, retry, compact, branch, search, newChat, openChat, deleteChat, deleteChats, restoreChat, renameChat, setReasoning, setMemory,
    setMemorySelection, setStarred, setFolder, setTemporary, folders, createFolder, updateFolder, deleteFolder, restoreFolder,
    saveConfig, modelLoad, loadModel,
  } = server;

  const modelConfig = useModelConfig(config?.model);
  const [replyStyle, setReplyStyle] = useReplyStyle();
  // A courtesy now rather than load-bearing: the turn survives a locked
  // screen regardless, since the server owns it. Any chat replying counts.
  useWakeLock(Object.keys(working).length > 0);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  // Wide enough, and the chat list stays on screen beside the thread; on a
  // phone it is a sheet, opened from the header or by a swipe in from the left.
  const wide = useMediaQuery(WIDE);
  // The sidebar can be tucked away, and stays that way across visits.
  const [sidebarOpen, setSidebarOpen] = useState(() => { try { return localStorage.getItem('lm-chat.sidebar') !== 'closed' } catch { return true } });
  const setSidebar = (open: boolean): void => {
    setSidebarOpen(open);
    try { localStorage.setItem('lm-chat.sidebar', open ? 'open' : 'closed') } catch { /* a preference, not a record */ }
  };
  const sidebar = wide && sidebarOpen;
  // The message bar can be tucked away too, on a wide screen, to read.
  const [composerOpen, setComposerOpen] = useState(() => { try { return localStorage.getItem('lm-chat.composer') !== 'closed' } catch { return true } });
  const setComposer = (open: boolean): void => {
    setComposerOpen(open);
    try { localStorage.setItem('lm-chat.composer', open ? 'open' : 'closed') } catch { /* a preference, not a record */ }
  };
  const composer = !wide || composerOpen;
  // On a phone, reading down a long reply tucks the header and the message
  // bar away; the first scroll back up brings them back. Never on a wide
  // screen, and never while the composer has focus (the keyboard is up).
  const [chromeHidden, setChromeHidden] = useState(false);
  useEffect(() => { setChromeHidden(false) }, [activeId]);
  /** Typed into the message box: a command rather than a message. */
  const runCommand = async (text: string): Promise<boolean> => {
    if (text.trim().toLowerCase() !== '/compact') return false;
    if (!active) { toast.error('No chat is open.'); return true; }
    const pending = toast.loading('Summarizing the conversation so far…');
    try {
      const { folded } = await compact();
      toast.success(`Compacted: ${folded} earlier message${folded === 1 ? '' : 's'} summarized and tucked away.`, { id: pending });
    } catch (err) {
      toast.error((err as Error).message, { id: pending });
    }
    return true;
  };
  const mainRef = useRef<HTMLDivElement>(null);
  useChromeHeights(mainRef);
  const swipe = useMemo(() => edgeSwipe(() => setChatsOpen(true)), []);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  // false: closed. 'browse': opened from Settings, every memory. 'select':
  // opened from the composer, picking which ones the active chat uses.
  const [memoriesOpen, setMemoriesOpen] = useState<false | 'browse' | 'select'>(false);
  // The chat a folder is being picked for; null when the picker is closed.
  const [folderPickerFor, setFolderPickerFor] = useState<string | null>(null);
  // A folder whose reasoning is being picked, and one being deleted that has chats to ask about.
  const [reasoningFolder, setReasoningFolder] = useState<Folder | null>(null);
  const [folderToDelete, setFolderToDelete] = useState<{ folder: Folder; count: number } | null>(null);

  /**
   * Delete a folder, keeping its chats (they move to Unfiled) or deleting
   * them too. Either way Undo puts it all back: the folder first, so the
   * chats have it to be filed into again.
   */
  const removeFolder = async (folder: Folder, withChats: boolean): Promise<void> => {
    setFolderToDelete(null);
    // In list order, reversed, so Undo restores them oldest-first and the list rebuilds as it was.
    const inside = conversations.filter((c) => c.folderId === folder.id);
    const snapshots = withChats ? [...inside].reverse() : [];
    try {
      if (withChats && inside.length) await deleteChats(inside.map((c) => c.id));
      const removed = await deleteFolder(folder.id);
      const n = inside.length;
      const chats = `${n} ${n === 1 ? 'chat' : 'chats'}`;
      const what = withChats ? `Deleted “${folder.name}” and its ${chats}`
        : n ? `Deleted “${folder.name}”; its ${chats} moved to Unfiled` : `Deleted “${folder.name}”`;
      toast(what, {
        duration: 10_000,
        action: {
          label: 'Undo',
          onClick: () => {
            void (async () => {
              try {
                await restoreFolder(removed);
                for (const c of snapshots) await restoreChat(c);
              } catch (err) {
                toast.error((err as Error).message);
              }
            })();
          },
        },
      });
    } catch (err) {
      toast.error((err as Error).message);
    }
  };
  // A search hit being opened: which chat, and the message to scroll to.
  const [jump, setJump] = useState<{ id: string; messageId: string } | null>(null);
  const activeFolder = active ? folders.find((f) => f.id === active.folderId) : undefined;
  // Memory is on unless this chat turned it off with the brain button.
  const memoryOn = active?.memory ?? true;
  const temporaryOn = active?.temporary === true;

  // Nothing to talk to yet: get the server configured first.
  useEffect(() => {
    if (config && !config.model) setSettingsOpen(true);
  }, [config]);

  const messages = active?.messages ?? [];
  const reasoning = active?.reasoning ?? null;
  const folderPickerConv = folderPickerFor ? conversations.find((c) => c.id === folderPickerFor) ?? null : null;
  // "Folder" (not "No folder"): short enough for the composer chip, still
  // reads as "tap to set one" rather than a label of its own.
  const folderLabel = active ? activeFolder?.name ?? 'Folder' : undefined;
  // What a chat with no level of its own gets: the folder's, else Settings'.
  const inheritedReasoning = activeFolder?.reasoning || config?.reasoning;

  const list = (
    <ConversationList
      open={chatsOpen}
      variant={wide ? 'sidebar' : 'sheet'}
      conversations={conversations}
      activeId={activeId}
      folders={folders}
      working={working}
      onOpen={(id) => void openChat(id)}
      onSearch={search}
      onOpenAt={(id, messageId) => { void openChat(id); setJump(messageId ? { id, messageId } : null); }}
      onDelete={(id) => void deleteChat(id)}
      onRestore={(conv) => void restoreChat(conv)}
      onDeleteMany={deleteChats}
      // One at a time, oldest-first, so the list rebuilds in its original order.
      onRestoreMany={async (convs) => { for (const c of convs) await restoreChat(c) }}
      onRename={(id, name) => void renameChat(id, name)}
      onStar={(id, starred) => void setStarred(id, starred)}
      onOpenFolderPicker={(id) => setFolderPickerFor(id)}
      onNewChat={(folderId) => void newChat(folderId)}
      onCreateFolder={createFolder}
      onRenameFolder={(id, name) => updateFolder(id, { name })}
      onFolderReasoning={setReasoningFolder}
      onDeleteFolder={(folder, count) => { if (count) setFolderToDelete({ folder, count }); else void removeFolder(folder, false); }}
      onOpenSettings={() => setSettingsOpen(true)}
      onCollapse={() => setSidebar(false)}
      onClose={() => setChatsOpen(false)}
    />
  );

  return (
    <div className={`app${sidebar ? ' with-sidebar' : ''}`}>
      <Toaster position="top-center" theme="dark" toastOptions={{ className: 'lm-chat-toast' }} />
      <Unreachable app="LM Chat" onBack={server.refresh} />
      {sidebar && list}
      <div
        ref={mainRef}
        className={`main${!wide && chromeHidden ? ' chrome-hidden' : ''}`}
        onFocusCapture={(e) => { if ((e.target as HTMLElement).closest?.('.composer')) setChromeHidden(false) }}
        onTouchStart={(e) => { const t = e.touches[0]; if (t) swipe.start(t.clientX, t.clientY); }}
        onTouchMove={(e) => { const t = e.touches[0]; if (t) swipe.move(t.clientX, t.clientY); }}
        onTouchEnd={swipe.end}
      >
      <Header
        status={status}
        startedAt={startedAt}
        title={active?.name || undefined}
        onNewChat={() => void newChat()}
        onRename={active && active.messages.length > 0 ? (name) => void renameChat(active.id, name) : undefined}
        // On a phone this opens the sheet; on a wide screen it brings a collapsed sidebar back.
        onOpenChats={sidebar ? undefined : () => (wide ? setSidebar(true) : setChatsOpen(true))}
      />
      {/* Keyed by thread: switching mounts a fresh one, rather than animating
          one thread's messages out while the other's animate in. */}
      {loadingActive
        // Mounted only once its messages are here: the thread restores your
        // reading position from them, once, as it mounts.
        ? <div className="thread" aria-busy="true" />
        : (
          <ChatThread
            key={activeId ?? 'none'} messages={messages} summary={active?.summary} conversationId={activeId ?? 'none'}
            title={active?.name || undefined}
            onRetry={busy ? undefined : () => void retry()}
            onEdit={(messageId, text) => branch(messageId, text).catch((err: Error) => { toast.error(err.message); })}
            focusMessageId={jump && jump.id === activeId ? jump.messageId : null}
            onScrollDirection={wide ? undefined : (d) => setChromeHidden(d === 'down')}
            // Folded by /compact, on the server: the summary stands in for what it covers.
            foldThrough={active?.folded && active.summary ? active.summary.through : null}
            recap={active?.folded ? active.recap ?? null : null}
          />
        )}
      {!composer && (
        <button type="button" className="composer-reveal" onClick={() => setComposer(true)} aria-label="Show message bar" title="Show the message bar">
          <PanelBottomOpen size={18} aria-hidden="true" />
        </button>
      )}
      {composer && <Composer
        onSend={(text, images) => { void runCommand(text).then((handled) => { if (!handled) void send(text, images) }) }}
        disabled={busy}
        busy={busy}
        onStop={() => void stop()}
        reasoningLabel={labelFor(reasoning, inheritedReasoning)}
        onOpenReasoning={() => setReasoningOpen(true)}
        temporaryOn={temporaryOn}
        onToggleTemporary={active ? () => void setTemporary(active.id, !temporaryOn) : undefined}
        folderLabel={folderLabel}
        onOpenFolderPicker={active ? () => setFolderPickerFor(active.id) : undefined}
        memoryOn={memoryOn}
        onToggleMemory={active ? () => void setMemory(!memoryOn) : undefined}
        onPickMemories={active ? () => setMemoriesOpen('select') : undefined}
        onCopyChat={active ? () => {
          navigator.clipboard.writeText(chatMarkdown(active)).then(
            () => toast.success('Chat copied as Markdown'),
            () => toast.error("Couldn't copy the chat"),
          );
        } : undefined}
        onDownloadChat={active ? () => downloadText(exportFileName(active.name), chatMarkdown(active)) : undefined}
        // The same as deleting it from the drawer: gone at once, with Undo in the toast.
        onDeleteChat={active ? () => {
          const snapshot = active;
          void deleteChat(snapshot.id);
          toast('Chat deleted', { action: { label: 'Undo', onClick: () => void restoreChat(snapshot) } });
        } : undefined}
        onCollapse={wide ? () => setComposer(false) : undefined}
      />}
      </div>
      <ReasoningPicker
        open={reasoningOpen}
        value={reasoning}
        defaultValue={inheritedReasoning}
        config={modelConfig}
        onChange={(v) => void setReasoning(v)}
        onClose={() => setReasoningOpen(false)}
      />
      {!sidebar && !wide && list}
      <SettingsSheet
        open={settingsOpen}
        config={config}
        modelConfig={modelConfig}
        onSave={saveConfig}
        modelLoad={modelLoad}
        onLoadModel={() => void loadModel()}
        onClose={() => setSettingsOpen(false)}
        onOpenMemories={() => { setSettingsOpen(false); setMemoriesOpen('browse'); }}
        replyStyle={replyStyle}
        onReplyStyleChange={setReplyStyle}
      />
      <MemoriesSheet
        open={memoriesOpen !== false}
        onClose={() => setMemoriesOpen(false)}
        selectFor={memoriesOpen === 'select' && active ? {
          selection: active.memorySelection ?? null,
          onChange: (value) => void setMemorySelection(active.id, value),
        } : undefined}
      />
      <FolderPicker
        open={folderPickerFor !== null}
        onClose={() => setFolderPickerFor(null)}
        folders={folders}
        currentFolderId={folderPickerConv?.folderId ?? null}
        onAssign={(folderId) => { if (folderPickerFor) void setFolder(folderPickerFor, folderId); }}
        onCreate={createFolder}
      />
      <ReasoningPicker
        open={reasoningFolder !== null}
        title={reasoningFolder ? `Reasoning for ${reasoningFolder.name}` : undefined}
        value={reasoningFolder?.reasoning ?? null}
        defaultValue={config?.reasoning}
        config={modelConfig}
        onChange={(v) => {
          if (reasoningFolder) void updateFolder(reasoningFolder.id, { reasoning: v }).catch((err: Error) => toast.error(err.message));
        }}
        onClose={() => setReasoningFolder(null)}
      />
      <FolderDeleteSheet
        target={folderToDelete}
        onKeepChats={() => { if (folderToDelete) void removeFolder(folderToDelete.folder, false); }}
        onDeleteChats={() => { if (folderToDelete) void removeFolder(folderToDelete.folder, true); }}
        onClose={() => setFolderToDelete(null)}
      />
    </div>
  );
}
