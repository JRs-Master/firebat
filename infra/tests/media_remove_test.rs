//! Deleting a media record — what it takes with it, and what it does when there is nothing left
//! to take.
//!
//! Measured 2026-09-08 on the live box: 611 derivative webp files (336.8 MB) had outlived the
//! records that declared them, because `remove` unlinked the original and the meta and left the
//! variants where they were. And a delete that had already succeeded reported failure twice over
//! — "미존재" when the second click arrived after the first finished, an ENOENT from the meta
//! unlink when it arrived in the middle — so the panel kept the card and the user clicked again.

use tempfile::tempdir;

use firebat_core::ports::IMediaPort;
use firebat_infra::adapters::media::LocalMediaAdapter;

/// Lay a record on disk the way a save would: the original, the five derivatives it declares,
/// and the meta that declares them.
fn plant(dir: &std::path::Path, slug: &str, extra_urls: &[&str]) -> std::path::PathBuf {
    let media = dir.join("user").join("media");
    std::fs::create_dir_all(&media).unwrap();
    std::fs::write(media.join(format!("{slug}.png")), b"original").unwrap();

    let sizes = ["480w", "768w", "1024w", "full"];
    let variants: Vec<String> = sizes
        .iter()
        .map(|s| {
            std::fs::write(media.join(format!("{slug}-{s}.webp")), b"derivative").unwrap();
            format!(
                r#"{{"width":480,"format":"webp","url":"/user/media/{slug}-{s}.webp","bytes":9}}"#
            )
        })
        .chain(extra_urls.iter().map(|u| {
            format!(r#"{{"width":480,"format":"webp","url":"{u}","bytes":9}}"#)
        }))
        .collect();
    std::fs::write(media.join(format!("{slug}-thumb.webp")), b"thumb").unwrap();

    std::fs::write(
        media.join(format!("{slug}.meta.json")),
        format!(
            r#"{{"slug":"{slug}","ext":"png","contentType":"image/png","bytes":8,
                 "createdAt":1,"thumbnailUrl":"/user/media/{slug}-thumb.webp",
                 "variants":[{}]}}"#,
            variants.join(",")
        ),
    )
    .unwrap();
    media
}

#[tokio::test]
async fn remove_takes_the_derivatives_it_declared() {
    let dir = tempdir().unwrap();
    let media = plant(dir.path(), "2026-09-08-probe-aaaa", &[]);
    let port = LocalMediaAdapter::new(dir.path());

    assert_eq!(std::fs::read_dir(&media).unwrap().count(), 7, "원본+파생5+meta");
    port.remove("2026-09-08-probe-aaaa").await.unwrap();
    let left: Vec<String> = std::fs::read_dir(&media)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(left.is_empty(), "찌꺼기가 남았다: {left:?}");
}

#[tokio::test]
async fn removing_twice_is_not_a_failure() {
    let dir = tempdir().unwrap();
    plant(dir.path(), "2026-09-08-probe-bbbb", &[]);
    let port = LocalMediaAdapter::new(dir.path());

    port.remove("2026-09-08-probe-bbbb").await.unwrap();
    // The second click. Absence is the state that was asked for, so arriving at it again is the
    // outcome, not an error — the panel used to show a different sentence for each of the two
    // windows this lands in.
    port.remove("2026-09-08-probe-bbbb")
        .await
        .expect("이미 지워진 것을 또 지우는 것은 실패가 아니다");
    port.remove("2026-09-08-never-existed-cccc")
        .await
        .expect("애초에 없던 것도 마찬가지");
}

#[tokio::test]
async fn a_declared_url_outside_the_slug_is_not_followed() {
    let dir = tempdir().unwrap();
    let media = plant(
        dir.path(),
        "2026-09-08-probe-dddd",
        &["/user/media/2026-09-08-someone-else-eeee-480w.webp", "/user/media/../../secret.txt"],
    );
    std::fs::write(media.join("2026-09-08-someone-else-eeee-480w.webp"), b"neighbour").unwrap();
    std::fs::write(dir.path().join("secret.txt"), b"not ours").unwrap();

    LocalMediaAdapter::new(dir.path())
        .remove("2026-09-08-probe-dddd")
        .await
        .unwrap();

    assert!(
        media.join("2026-09-08-someone-else-eeee-480w.webp").exists(),
        "이웃 레코드의 파생을 지웠다"
    );
    assert!(dir.path().join("secret.txt").exists(), "선언이 디렉터리 밖을 짚었다");
}
