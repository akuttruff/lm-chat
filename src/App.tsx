import { useState, useEffect } from 'react';
import { Toaster, toast } from 'sonner';
import Header from './components/Header';
import ChatThread from './components/ChatThread';
import Composer from './components/Composer';
import SettingsSheet from './components/SettingsSheet';
import MemoriesSheet from './components/MemoriesSheet';
import ConversationList from './components/ConversationList';
import FolderPicker from './components/FolderPicker';
import ToolPicker from './components/ToolPicker';
import ReasoningPicker, { labelFor } from './components/ReasoningPicker';
import useServerState from './hooks/useServerState';
import { chatMarkdown, downloadText, exportFileName } from './lib/export';
import useModelConfig from './hooks/useModelConfig';
import useReplyStyle from './hooks/useReplyStyle';
import useWakeLock from './hooks/useWakeLock';
import './App.css';

export default function App() {
  const server = useServerState();
  const {
    conversations, activeId, active, loadingActive, config, status, startedAt, busy, working,
    send, stop, retry, branch, search, newChat, openChat, deleteChat, deleteChats, restoreChat, renameChat, setReasoning, setMemory,
    setMemorySelection, setStarred, setFolder, setTemporary, setTools, folders, createFolder, updateFolder, deleteFolder,
    saveConfig,
  } = server;

  const modelConfig = useModelConfig(config?.model);
  const [replyStyle, setReplyStyle] = useReplyStyle();
  // A courtesy now rather than load-bearing: the turn survives a locked
  // screen regardless, since the server owns it. Any chat replying counts.
  useWakeLock(Object.keys(working).length > 0);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [reasoningOpen, setReasoningOpen] = useState(false);
  // false: closed. 'browse': opened from Settings, every memory. 'select':
  // opened from the composer, picking which ones the active chat uses.
  const [memoriesOpen, setMemoriesOpen] = useState<false | 'browse' | 'select'>(false);
  // The chat a folder is being picked for; null when the picker is closed.
  const [folderPickerFor, setFolderPickerFor] = useState<string | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  // A search hit being opened: which chat, and the message to scroll to.
  const [jump, setJump] = useState<{ id: string; messageId: string } | null>(null);
  const activeFolder = active ? folders.find((f) => f.id === active.folderId) : undefined;
  // This chat's own setting, else the folder's, else the Settings default.
  const memoryOn = active?.memory ?? activeFolder?.memory ?? config?.memoryDefault === 'on';
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

  return (
    <div className="app">
      <Toaster position="top-center" theme="dark" toastOptions={{ className: 'lm-chat-toast' }} />
      <Header
        status={status}
        startedAt={startedAt}
        onNewChat={() => void newChat()}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenChats={() => setChatsOpen(true)}
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
          />
        )}
      <Composer
        onSend={(text, images) => void send(text, images)}
        disabled={busy}
        busy={busy}
        onStop={() => void stop()}
        reasoningLabel={labelFor(reasoning, inheritedReasoning)}
        onOpenReasoning={() => setReasoningOpen(true)}
        temporaryOn={temporaryOn}
        onToggleTemporary={active ? () => void setTemporary(active.id, !temporaryOn) : undefined}
        folderLabel={folderLabel}
        onOpenFolderPicker={active ? () => setFolderPickerFor(active.id) : undefined}
        onOpenTools={active ? () => setToolsOpen(true) : undefined}
        toolsCustomized={active?.tools != null}
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
      />
      <ReasoningPicker
        open={reasoningOpen}
        value={reasoning}
        defaultValue={inheritedReasoning}
        config={modelConfig}
        onChange={(v) => void setReasoning(v)}
        onClose={() => setReasoningOpen(false)}
      />
      <ConversationList
        open={chatsOpen}
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
        onClose={() => setChatsOpen(false)}
      />
      <SettingsSheet
        open={settingsOpen}
        config={config}
        modelConfig={modelConfig}
        onSave={saveConfig}
        onClose={() => setSettingsOpen(false)}
        onOpenMemories={() => { setSettingsOpen(false); setMemoriesOpen('browse'); }}
        replyStyle={replyStyle}
        onReplyStyleChange={setReplyStyle}
      />
      <MemoriesSheet
        open={memoriesOpen !== false}
        onClose={() => setMemoriesOpen(false)}
        selectFor={memoriesOpen === 'select' && active ? {
          // The chat's own pick, else the folder's; a change gives the chat its own.
          selection: active.memorySelection ?? activeFolder?.memorySelection ?? null,
          fromFolder: active.memorySelection == null && activeFolder?.memorySelection != null,
          onChange: (value) => void setMemorySelection(active.id, value),
        } : undefined}
      />
      {active && (
        <ToolPicker
          open={toolsOpen}
          onClose={() => setToolsOpen(false)}
          value={active.tools ?? null}
          inherited={activeFolder?.mcpTools ?? config?.mcpTools ?? ''}
          inheritedFrom={activeFolder?.mcpTools != null ? 'folder' : 'Settings'}
          onChange={(tools) => void setTools(active.id, tools)}
        />
      )}
      <FolderPicker
        open={folderPickerFor !== null}
        onClose={() => setFolderPickerFor(null)}
        folders={folders}
        currentFolderId={folderPickerConv?.folderId ?? null}
        onAssign={(folderId) => { if (folderPickerFor) void setFolder(folderPickerFor, folderId); }}
        onCreate={createFolder}
        onUpdate={updateFolder}
        onDelete={deleteFolder}
        modelConfig={modelConfig}
        config={config}
      />
    </div>
  );
}
