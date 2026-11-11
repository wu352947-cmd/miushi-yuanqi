"""请求 / 响应模型。字段尽量和前端现有形状一致，减少两边转换。"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    password: str = ""


class StateIn(BaseModel):
    state: dict[str, Any] = Field(default_factory=dict)


class MigrateIn(BaseModel):
    state: dict[str, Any] = Field(default_factory=dict)
    includeApiKeys: bool = False
    includeKeys: bool | None = None


class ChatSendIn(BaseModel):
    text: str = ""
    modelId: str | None = None
    reasoningLevel: str | None = None
    chatId: str | None = None
    mode: str = "normal"

class ChatCreateIn(BaseModel):
    characterId: str = ""
    title: str | None = None
    personaId: str | None = None
    worldBookId: str | None = None
    presetId: str | None = None
    modelId: str | None = None
    reasoningLevel: str | None = None
    settings: dict[str, Any] | None = None
    pinned: bool | None = None

class ChatDetailPatch(BaseModel):
    title: str | None = None
    pinned: bool | None = None
    personaId: str | None = None
    worldBookId: str | None = None
    presetId: str | None = None
    modelId: str | None = None
    reasoningLevel: str | None = None
    settings: dict[str, Any] | None = None
    titleLocked: bool | None = None

class MessageEditIn(BaseModel):
    text: str = ""

class ChatBranchIn(BaseModel):
    messageId: int

class ChatImportIn(BaseModel):
    format: str = "auto"
    content: str = ""
    payload: dict[str, Any] | None = None
    characterId: str = ""

class ChatBulkIn(BaseModel):
    chatIds: list[str] = Field(default_factory=list)

class ImpersonateIn(BaseModel):
    modelId: str | None = None
    reasoningLevel: str | None = None


class KeyIn(BaseModel):
    apiKey: str = ""


class FavoriteIn(BaseModel):
    favorite: bool = False


class MemoryIn(BaseModel):
    title: str = ""
    body: str = ""
    category: str = ""
    cat: str = ""
    importance: int = 5
    tags: list[str] = Field(default_factory=list)
    source: str = ""
    sourceChatId: str = ""
    pinned: bool = False
    protected: bool = False
    scope: str = "pair"
    characterId: str = ""
    personaId: str = ""


class MemoryPatch(BaseModel):
    title: str | None = None
    body: str | None = None
    category: str | None = None
    cat: str | None = None
    importance: int | None = None
    tags: list[str] | None = None
    source: str | None = None
    protected: bool | None = None


class NowIn(BaseModel):
    body: str = ""
    characterId: str = ""
    personaId: str = ""


class RememberIn(BaseModel):
    text: str = ""
    title: str = ""
    category: str = ""
    importance: int = 7
    chatId: str = ""
    characterId: str = ""
    personaId: str = ""
    scope: str = "pair"
    source: str = "手动"


class ExtractIn(BaseModel):
    characterId: str = ""
    personaId: str = ""


class ProviderIn(BaseModel):
    provider: dict[str, Any] = Field(default_factory=dict)


class ModelIn(BaseModel):
    model: dict[str, Any] = Field(default_factory=dict)


class CharacterIn(BaseModel):
    character: dict[str, Any] = Field(default_factory=dict)


class PersonaIn(BaseModel):
    persona: dict[str, Any] = Field(default_factory=dict)


class BookIn(BaseModel):
    book: dict[str, Any] = Field(default_factory=dict)


class EntryIn(BaseModel):
    entry: dict[str, Any] = Field(default_factory=dict)


class PresetIn(BaseModel):
    preset: dict[str, Any] = Field(default_factory=dict)


class ChatPatch(BaseModel):
    personaId: str | None = None
    worldBookId: str | None = None
    presetId: str | None = None
    modelId: str | None = None
    reasoningLevel: str | None = None
    title: str | None = None


class SettingsIn(BaseModel):
    settings: dict[str, Any] = Field(default_factory=dict)


class ImportPayload(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)


class ProviderImportIn(BaseModel):
    payload: dict[str, Any] = Field(default_factory=dict)
    includeApiKey: bool = False
