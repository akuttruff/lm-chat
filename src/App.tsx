import { useState, useEffect } from 'react';
import { Toaster } from 'sonner';
import Header from './components/Header';
import ChatThread from './components/ChatThread';
import Composer from './components/Composer';
import SettingsSheet from './components/SettingsSheet';
import MemoriesSheet from './components/MemoriesSheet';
import ConversationList from './components/ConversationList';
import FolderPicker from './components/FolderPicker';
import ReasoningPicker, { labelFor } from './components/ReasoningPicker';
import useServerState from './hooks/useServerState';
import useModelConfig from './hooks/useModelConfig';
import useReplyStyle from './hooks/useReplyStyle';
import useWakeLock from './hooks/useWakeLock';
import './App.css';

export default function App() {
  const server = useServerState();
  const {
    conversations, activeId, active, loadingActive, config, status, startedAt, busy, working,
    send, stop, retry, newChat, openChat, deleteChat, restoreChat, renameChat, setReasoning, setMemory,
    setMemorySelection, setStarred, setFolder, setTemporary, folders, createFolder, updateFolder, deleteFolder,
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
  // This chat's own setting, else the Settings default.
  const memoryOn = active?.memory ?? config?.memoryDefault === 'on';
  const temporaryOn = active?.temporary === true;

  // Nothing to talk to yet: get the server configured first.
  useEffect(() => {
    if (config && !config.model) setSettingsOpen(true);
  }, [config]);

  const messages = active?.messages ?? [];
  const reasoning = active?.reasoning ?? null;
  const folderPickerConv = folderPickerFor ? conversations.find((c) => c.id === folderPickerFor) ?? null : null;
  const activeFolder = active ? folders.find((f) => f.id === active.folderId) : undefined;
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
            onRetry={busy ? undefined : () => void retry()}
          />
        )}
      <Composer
        onSend={(text) => void send(text)}
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
        onDelete={(id) => void deleteChat(id)}
        onRestore={(conv) => void restoreChat(conv)}
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
        onUpdate={updateFolder}
        onDelete={deleteFolder}
        modelConfig={modelConfig}
        config={config}
      />
    </div>
  );
}
