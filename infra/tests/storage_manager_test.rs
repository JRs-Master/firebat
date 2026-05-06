//! StorageManager integration test — 옛 core inline tests 이관.

use std::sync::Arc;
use tempfile::TempDir;

use firebat_core::managers::storage::StorageManager;
use firebat_core::ports::IStoragePort;
use firebat_infra::adapters::storage::LocalStorageAdapter;

fn make_manager() -> (StorageManager, TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let storage: Arc<dyn IStoragePort> =
        Arc::new(LocalStorageAdapter::new(dir.path().to_path_buf()));
    (StorageManager::new(storage), dir)
}

#[tokio::test]
async fn read_write_roundtrip() {
    let (mgr, _dir) = make_manager();
    mgr.write("test.txt", "hello").await.unwrap();
    let content = mgr.read("test.txt").await.unwrap();
    assert_eq!(content, "hello");
}

#[tokio::test]
async fn delete_removes_file() {
    let (mgr, _dir) = make_manager();
    mgr.write("delete-me.txt", "x").await.unwrap();
    assert!(mgr.exists("delete-me.txt").await);
    mgr.delete("delete-me.txt").await.unwrap();
    assert!(!mgr.exists("delete-me.txt").await);
}

#[tokio::test]
async fn list_dir_returns_entries() {
    let (mgr, _dir) = make_manager();
    mgr.write("dir/a.txt", "1").await.unwrap();
    mgr.write("dir/b.txt", "2").await.unwrap();
    let entries = mgr.list_dir("dir").await.unwrap();
    assert_eq!(entries.len(), 2);
}

#[tokio::test]
async fn file_tree_recursive_builds_nested_structure() {
    let (mgr, _dir) = make_manager();
    mgr.write("root/a.txt", "1").await.unwrap();
    mgr.write("root/sub/b.txt", "2").await.unwrap();
    mgr.write("root/sub/deep/c.txt", "3").await.unwrap();

    let tree = mgr.get_file_tree("root").await;
    assert_eq!(tree.len(), 1);
    let root = &tree[0];
    assert_eq!(root.name, "root");
    assert!(root.is_directory);

    // 디렉토리 우선 정렬 → sub 가 a.txt 보다 먼저
    assert_eq!(root.children.len(), 2);
    assert_eq!(root.children[0].name, "sub");
    assert!(root.children[0].is_directory);
    assert_eq!(root.children[1].name, "a.txt");
    assert!(!root.children[1].is_directory);

    // sub 안 — deep (디렉토리) 우선, b.txt 뒤
    let sub = &root.children[0];
    assert_eq!(sub.children.len(), 2);
    assert_eq!(sub.children[0].name, "deep");
    assert_eq!(sub.children[1].name, "b.txt");

    // deep 안 — c.txt 단독
    assert_eq!(sub.children[0].children.len(), 1);
    assert_eq!(sub.children[0].children[0].name, "c.txt");
}

#[tokio::test]
async fn file_tree_skips_hidden_and_bracket_entries() {
    let (mgr, _dir) = make_manager();
    mgr.write("root/visible.txt", "1").await.unwrap();
    mgr.write("root/.hidden.txt", "2").await.unwrap();
    mgr.write("root/[dynamic]/page.txt", "3").await.unwrap();

    let tree = mgr.get_file_tree("root").await;
    let root = &tree[0];
    // .hidden.txt 와 [dynamic] 디렉토리 모두 제외
    let names: Vec<&str> = root.children.iter().map(|n| n.name.as_str()).collect();
    assert_eq!(names, vec!["visible.txt"]);
}

#[tokio::test]
async fn file_tree_alphabetical_within_kind() {
    let (mgr, _dir) = make_manager();
    mgr.write("root/zeta/x.txt", "1").await.unwrap();
    mgr.write("root/alpha/x.txt", "2").await.unwrap();
    mgr.write("root/beta/x.txt", "3").await.unwrap();
    mgr.write("root/zfile.txt", "4").await.unwrap();
    mgr.write("root/afile.txt", "5").await.unwrap();

    let tree = mgr.get_file_tree("root").await;
    let names: Vec<&str> = tree[0]
        .children
        .iter()
        .map(|n| n.name.as_str())
        .collect();
    // 디렉토리 3개 (alpha/beta/zeta) → 파일 2개 (afile/zfile)
    assert_eq!(names, vec!["alpha", "beta", "zeta", "afile.txt", "zfile.txt"]);
}

#[tokio::test]
async fn file_tree_missing_root_returns_empty_children() {
    let (mgr, _dir) = make_manager();
    let tree = mgr.get_file_tree("nonexistent-root").await;
    assert_eq!(tree.len(), 1);
    // root TreeNode 자체는 박히고 children 만 비어있음 (옛 TS 와 동일 동작)
    assert!(tree[0].children.is_empty());
}

#[tokio::test]
async fn file_trees_multi_root() {
    let (mgr, _dir) = make_manager();
    mgr.write("root1/a.txt", "1").await.unwrap();
    mgr.write("root2/b.txt", "2").await.unwrap();

    let tree = mgr.get_file_trees(&["root1", "root2"]).await;
    assert_eq!(tree.len(), 2);
    assert_eq!(tree[0].name, "root1");
    assert_eq!(tree[1].name, "root2");
    assert_eq!(tree[0].children.len(), 1);
    assert_eq!(tree[0].children[0].name, "a.txt");
}
