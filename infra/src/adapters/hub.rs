//! SqliteHubAdapter — IHubPort 의 SQLite 구현 (memory.db 통합).
//!
//! Hub Phase 1 (2026-05-17) — system service `hub`. 외부 워드프레스 사이트 영역 연결용.
//! 매 instance = 매 챗봇 (slug 별), 매 conversation = (instance, session_id) 별 대화,
//! 매 message = 대화 안 메시지.
//!
//! Schema = `infra/src/adapters/memory.rs::initialize()` 영역에 박혀있음 (hub_instances /
//! hub_conversations / hub_messages 3 tables). 부팅 시점 SqliteMemoryAdapter 가 자동.
//! 본 어댑터 = 별도 Connection (Mutex) — 옛 Library 패턴 동일.

use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::Mutex;

use firebat_core::ports::{
    HubConversation, HubInstance, HubMessage, IHubPort, InfraResult,
};

pub struct SqliteHubAdapter {
    conn: Mutex<Connection>,
}

impl SqliteHubAdapter {
    pub fn new(db_path: impl AsRef<Path>) -> Result<Self, String> {
        let path = db_path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Hub DB 디렉토리 생성 실패: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("Hub DB open 실패: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    #[cfg(test)]
    pub fn new_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("Hub DB in-memory open 실패: {e}"))?;
        conn.execute_batch(
            r#"
            CREATE TABLE hub_instances (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                system_prompt TEXT,
                allowed_references TEXT NOT NULL DEFAULT '[]',
                allowed_sysmods TEXT NOT NULL DEFAULT '[]',
                model_id TEXT,
                enabled INTEGER NOT NULL DEFAULT 1,
                api_token TEXT NOT NULL,
                allowed_domains TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                expose_widget INTEGER NOT NULL DEFAULT 1,
                expose_page INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE hub_conversations (
                id TEXT PRIMARY KEY,
                instance_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                title TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                FOREIGN KEY (instance_id) REFERENCES hub_instances(id) ON DELETE CASCADE
            );
            CREATE TABLE hub_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT,
                data_json TEXT,
                created_at INTEGER NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES hub_conversations(id) ON DELETE CASCADE
            );
            "#,
        )
        .map_err(|e| format!("Hub test schema 초기화 실패: {e}"))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn json_array_to_vec(s: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(s).unwrap_or_default()
}

fn vec_to_json_array(v: &[String]) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string())
}

#[async_trait::async_trait]
impl IHubPort for SqliteHubAdapter {
    // ─── Instance CRUD ────────────────────────────────────────────────────

    async fn create_instance(&self, instance: &HubInstance) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO hub_instances (
                id, slug, name, description, system_prompt,
                allowed_references, allowed_sysmods, model_id, enabled,
                api_token, allowed_domains, created_at, updated_at,
                expose_widget, expose_page
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![
                instance.id,
                instance.slug,
                instance.name,
                instance.description,
                instance.system_prompt,
                vec_to_json_array(&instance.allowed_references),
                vec_to_json_array(&instance.allowed_sysmods),
                instance.model_id,
                instance.enabled as i64,
                instance.api_token,
                vec_to_json_array(&instance.allowed_domains),
                instance.created_at,
                instance.updated_at,
                instance.expose_widget as i64,
                instance.expose_page as i64,
            ],
        )
        .map_err(|e| format!("hub_instances insert: {e}"))?;
        Ok(())
    }

    async fn list_instances(&self) -> InfraResult<Vec<HubInstance>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, slug, name, description, system_prompt,
                        allowed_references, allowed_sysmods, model_id, enabled,
                        api_token, allowed_domains, created_at, updated_at,
                        expose_widget, expose_page
                 FROM hub_instances
                 ORDER BY updated_at DESC",
            )
            .map_err(|e| format!("hub_instances list prepare: {e}"))?;
        let rows = stmt
            .query_map([], row_to_instance)
            .map_err(|e| format!("hub_instances list query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("hub_instances list row: {e}"))?);
        }
        Ok(out)
    }

    async fn get_instance(&self, id: &str) -> InfraResult<Option<HubInstance>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, slug, name, description, system_prompt,
                        allowed_references, allowed_sysmods, model_id, enabled,
                        api_token, allowed_domains, created_at, updated_at,
                        expose_widget, expose_page
                 FROM hub_instances WHERE id = ?1",
            )
            .map_err(|e| format!("hub_instances get prepare: {e}"))?;
        let result = stmt.query_row(params![id], row_to_instance).ok();
        Ok(result)
    }

    async fn get_instance_by_slug(&self, slug: &str) -> InfraResult<Option<HubInstance>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, slug, name, description, system_prompt,
                        allowed_references, allowed_sysmods, model_id, enabled,
                        api_token, allowed_domains, created_at, updated_at,
                        expose_widget, expose_page
                 FROM hub_instances WHERE slug = ?1",
            )
            .map_err(|e| format!("hub_instances get_by_slug prepare: {e}"))?;
        let result = stmt.query_row(params![slug], row_to_instance).ok();
        Ok(result)
    }

    async fn update_instance(&self, instance: &HubInstance) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        let updated_at = now_ms();
        conn.execute(
            "UPDATE hub_instances SET
                slug = ?1, name = ?2, description = ?3, system_prompt = ?4,
                allowed_references = ?5, allowed_sysmods = ?6, model_id = ?7, enabled = ?8,
                api_token = ?9, allowed_domains = ?10, updated_at = ?11,
                expose_widget = ?12, expose_page = ?13
             WHERE id = ?14",
            params![
                instance.slug,
                instance.name,
                instance.description,
                instance.system_prompt,
                vec_to_json_array(&instance.allowed_references),
                vec_to_json_array(&instance.allowed_sysmods),
                instance.model_id,
                instance.enabled as i64,
                instance.api_token,
                vec_to_json_array(&instance.allowed_domains),
                updated_at,
                instance.expose_widget as i64,
                instance.expose_page as i64,
                instance.id,
            ],
        )
        .map_err(|e| format!("hub_instances update: {e}"))?;
        Ok(())
    }

    async fn delete_instance(&self, id: &str) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        // SQLite 의 PRAGMA foreign_keys 가 OFF 박혀있어도 명시 cascade 박음 (defense-in-depth):
        //   instance 삭제 → 그 instance 의 모든 conversations + messages 같이 삭제.
        // hub_messages 가 conversation_id FK 박혀있어 conv 삭제 시 messages 도 같이 박혀야.
        // 순서: messages → conversations → instance (자식 → 부모).
        conn.execute(
            "DELETE FROM hub_messages WHERE conversation_id IN
                (SELECT id FROM hub_conversations WHERE instance_id = ?1)",
            params![id],
        )
        .map_err(|e| format!("hub_messages cascade delete: {e}"))?;
        conn.execute(
            "DELETE FROM hub_conversations WHERE instance_id = ?1",
            params![id],
        )
        .map_err(|e| format!("hub_conversations cascade delete: {e}"))?;
        conn.execute("DELETE FROM hub_instances WHERE id = ?1", params![id])
            .map_err(|e| format!("hub_instances delete: {e}"))?;
        Ok(())
    }

    // ─── Conversation ─────────────────────────────────────────────────────

    async fn ensure_conversation(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<String> {
        let conn = self.conn.lock().unwrap();
        // 옛 (instance_id, session_id) 의 마지막 활성 대화 찾기.
        let existing: Option<String> = conn
            .query_row(
                "SELECT id FROM hub_conversations
                 WHERE instance_id = ?1 AND session_id = ?2
                 ORDER BY updated_at DESC LIMIT 1",
                params![instance_id, session_id],
                |row| row.get(0),
            )
            .ok();
        if let Some(id) = existing {
            return Ok(id);
        }
        // 새 대화 생성.
        let id = uuid::Uuid::new_v4().to_string();
        let ts = now_ms();
        conn.execute(
            "INSERT INTO hub_conversations
                (id, instance_id, session_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
            params![id, instance_id, session_id, ts, ts],
        )
        .map_err(|e| format!("hub_conversations insert: {e}"))?;
        Ok(id)
    }

    async fn create_conversation(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<String> {
        // 옛 conv 있어도 항상 새 conv 박음 — multi-conv 시나리오.
        let conn = self.conn.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let ts = now_ms();
        conn.execute(
            "INSERT INTO hub_conversations
                (id, instance_id, session_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, NULL, ?4, ?5)",
            params![id, instance_id, session_id, ts, ts],
        )
        .map_err(|e| format!("hub_conversations insert: {e}"))?;
        Ok(id)
    }

    async fn list_conversations(
        &self,
        instance_id: &str,
        session_id: &str,
    ) -> InfraResult<Vec<HubConversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, instance_id, session_id, title, created_at, updated_at
                 FROM hub_conversations
                 WHERE instance_id = ?1 AND session_id = ?2
                 ORDER BY updated_at DESC",
            )
            .map_err(|e| format!("hub_conversations list prepare: {e}"))?;
        let rows = stmt
            .query_map(params![instance_id, session_id], row_to_conversation)
            .map_err(|e| format!("hub_conversations list query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("hub_conversations list row: {e}"))?);
        }
        Ok(out)
    }

    async fn get_conversation(&self, id: &str) -> InfraResult<Option<HubConversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, instance_id, session_id, title, created_at, updated_at
                 FROM hub_conversations WHERE id = ?1",
            )
            .map_err(|e| format!("hub_conversations get prepare: {e}"))?;
        let result = stmt.query_row(params![id], row_to_conversation).ok();
        Ok(result)
    }

    async fn delete_conversation(&self, id: &str) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        // 명시 cascade — messages 먼저 삭제 + conversation 삭제. SQLite foreign_keys OFF 박혀있어도 OK.
        conn.execute(
            "DELETE FROM hub_messages WHERE conversation_id = ?1",
            params![id],
        )
        .map_err(|e| format!("hub_messages cascade delete: {e}"))?;
        conn.execute(
            "DELETE FROM hub_conversations WHERE id = ?1",
            params![id],
        )
        .map_err(|e| format!("hub_conversations delete: {e}"))?;
        Ok(())
    }

    async fn update_conversation_title(&self, id: &str, title: &str) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        let ts = now_ms();
        conn.execute(
            "UPDATE hub_conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            params![title, ts, id],
        )
        .map_err(|e| format!("hub_conversations update_title: {e}"))?;
        Ok(())
    }

    // ─── Message ──────────────────────────────────────────────────────────

    async fn append_message(&self, msg: &HubMessage) -> InfraResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO hub_messages
                (id, conversation_id, role, content, data_json, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                msg.id,
                msg.conversation_id,
                msg.role,
                msg.content,
                msg.data_json,
                msg.created_at,
            ],
        )
        .map_err(|e| format!("hub_messages insert: {e}"))?;
        // 대화 updated_at 갱신.
        conn.execute(
            "UPDATE hub_conversations SET updated_at = ?1 WHERE id = ?2",
            params![msg.created_at, msg.conversation_id],
        )
        .map_err(|e| format!("hub_conversations touch: {e}"))?;
        Ok(())
    }

    async fn list_messages(&self, conversation_id: &str) -> InfraResult<Vec<HubMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, conversation_id, role, content, data_json, created_at
                 FROM hub_messages
                 WHERE conversation_id = ?1
                 ORDER BY created_at ASC",
            )
            .map_err(|e| format!("hub_messages list prepare: {e}"))?;
        let rows = stmt
            .query_map(params![conversation_id], row_to_message)
            .map_err(|e| format!("hub_messages list query: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("hub_messages list row: {e}"))?);
        }
        Ok(out)
    }
}

// ─── row → struct 매핑 ──────────────────────────────────────────────────────

fn row_to_instance(row: &rusqlite::Row) -> rusqlite::Result<HubInstance> {
    Ok(HubInstance {
        id: row.get(0)?,
        slug: row.get(1)?,
        name: row.get(2)?,
        description: row.get(3)?,
        system_prompt: row.get(4)?,
        allowed_references: json_array_to_vec(&row.get::<_, String>(5)?),
        allowed_sysmods: json_array_to_vec(&row.get::<_, String>(6)?),
        model_id: row.get(7)?,
        enabled: row.get::<_, i64>(8)? != 0,
        api_token: row.get(9)?,
        allowed_domains: json_array_to_vec(&row.get::<_, String>(10)?),
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        expose_widget: row.get::<_, i64>(13)? != 0,
        expose_page: row.get::<_, i64>(14)? != 0,
    })
}

fn row_to_conversation(row: &rusqlite::Row) -> rusqlite::Result<HubConversation> {
    Ok(HubConversation {
        id: row.get(0)?,
        instance_id: row.get(1)?,
        session_id: row.get(2)?,
        title: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
    })
}

fn row_to_message(row: &rusqlite::Row) -> rusqlite::Result<HubMessage> {
    Ok(HubMessage {
        id: row.get(0)?,
        conversation_id: row.get(1)?,
        role: row.get(2)?,
        content: row.get(3)?,
        data_json: row.get(4)?,
        created_at: row.get(5)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_instance(slug: &str) -> HubInstance {
        let ts = now_ms();
        HubInstance {
            id: uuid::Uuid::new_v4().to_string(),
            slug: slug.to_string(),
            name: slug.to_string(),
            description: None,
            system_prompt: None,
            allowed_references: vec!["ref-1".into()],
            allowed_sysmods: vec!["calendar".into()],
            model_id: None,
            enabled: true,
            api_token: "tok-test-1234567890".to_string(),
            allowed_domains: vec!["https://example.com".into()],
            created_at: ts,
            updated_at: ts,
            expose_widget: true,
            expose_page: true,
        }
    }

    #[tokio::test]
    async fn instance_crud_roundtrip() {
        let adapter = SqliteHubAdapter::new_in_memory().unwrap();
        let inst = make_instance("test-slug");
        adapter.create_instance(&inst).await.unwrap();

        let by_id = adapter.get_instance(&inst.id).await.unwrap().unwrap();
        assert_eq!(by_id.slug, "test-slug");
        assert_eq!(by_id.allowed_references, vec!["ref-1".to_string()]);
        assert_eq!(by_id.allowed_sysmods, vec!["calendar".to_string()]);
        assert!(by_id.enabled);

        let by_slug = adapter
            .get_instance_by_slug("test-slug")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(by_slug.id, inst.id);

        let all = adapter.list_instances().await.unwrap();
        assert_eq!(all.len(), 1);

        // update
        let mut updated = inst.clone();
        updated.name = "renamed".into();
        updated.enabled = false;
        adapter.update_instance(&updated).await.unwrap();
        let after = adapter.get_instance(&inst.id).await.unwrap().unwrap();
        assert_eq!(after.name, "renamed");
        assert!(!after.enabled);

        // delete
        adapter.delete_instance(&inst.id).await.unwrap();
        assert!(adapter.get_instance(&inst.id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn conversation_ensure_returns_same_id_for_same_session() {
        let adapter = SqliteHubAdapter::new_in_memory().unwrap();
        let inst = make_instance("c-test");
        adapter.create_instance(&inst).await.unwrap();

        let conv1 = adapter
            .ensure_conversation(&inst.id, "session-abc")
            .await
            .unwrap();
        let conv2 = adapter
            .ensure_conversation(&inst.id, "session-abc")
            .await
            .unwrap();
        assert_eq!(conv1, conv2, "같은 session_id 면 옛 대화 id 반환");

        let conv3 = adapter
            .ensure_conversation(&inst.id, "session-xyz")
            .await
            .unwrap();
        assert_ne!(conv1, conv3, "다른 session_id 면 새 대화");
    }

    #[tokio::test]
    async fn messages_append_and_list_ordered() {
        let adapter = SqliteHubAdapter::new_in_memory().unwrap();
        let inst = make_instance("m-test");
        adapter.create_instance(&inst).await.unwrap();
        let conv_id = adapter
            .ensure_conversation(&inst.id, "s1")
            .await
            .unwrap();

        for i in 0..3 {
            let msg = HubMessage {
                id: uuid::Uuid::new_v4().to_string(),
                conversation_id: conv_id.clone(),
                role: if i % 2 == 0 { "user".into() } else { "system".into() },
                content: Some(format!("msg-{i}")),
                data_json: None,
                created_at: now_ms() + i,
            };
            adapter.append_message(&msg).await.unwrap();
        }

        let msgs = adapter.list_messages(&conv_id).await.unwrap();
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0].content.as_deref(), Some("msg-0"));
        assert_eq!(msgs[2].content.as_deref(), Some("msg-2"));
    }
}
