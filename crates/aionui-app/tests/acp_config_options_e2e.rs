mod common;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use serde_json::json;
use tower::ServiceExt;

use common::{body_json, build_app_with_mock_agents, json_with_token, setup_and_login};

fn create_body() -> serde_json::Value {
    json!({
        "type": "acp",
        "name": "Config Options",
        "extra": {}
    })
}

async fn create_conversation(app: &mut axum::Router, token: &str, csrf: &str) -> String {
    let req = json_with_token("POST", "/api/conversations", create_body(), token, csrf);
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::CREATED);
    let json = body_json(resp).await;
    json["data"]["id"].as_str().unwrap().to_owned()
}

async fn create_and_ensure_runtime_conversation(app: &mut axum::Router, token: &str, csrf: &str) -> String {
    let id = create_conversation(app, token, csrf).await;
    let req = json_with_token(
        "POST",
        &format!("/api/conversations/{id}/runtime/ensure"),
        json!(null),
        token,
        csrf,
    );
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    id
}

#[tokio::test]
async fn runtime_ensure_requires_auth() {
    let (app, _services) = build_app_with_mock_agents().await;
    let csrf = "csrf-test";

    let resp = app
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/conversations/conv-1/runtime/ensure")
                .header("x-csrf-token", csrf)
                .header("cookie", format!("aionui-csrf-token={csrf}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    let json = body_json(resp).await;
    assert_eq!(json["code"], "UNAUTHORIZED");
}

#[tokio::test]
async fn runtime_ensure_requires_csrf() {
    let (mut app, services) = build_app_with_mock_agents().await;
    let (token, csrf) = setup_and_login(&mut app, &services, "admin", "StrongP@ss1").await;
    let id = create_conversation(&mut app, &token, &csrf).await;

    let req = Request::builder()
        .method("POST")
        .uri(format!("/api/conversations/{id}/runtime/ensure"))
        .header("authorization", format!("Bearer {token}"))
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let json = body_json(resp).await;
    assert_eq!(json["code"], "CSRF_INVALID");
}

#[tokio::test]
async fn legacy_warmup_route_is_removed() {
    let (mut app, services) = build_app_with_mock_agents().await;
    let (token, csrf) = setup_and_login(&mut app, &services, "admin", "StrongP@ss1").await;
    let id = create_conversation(&mut app, &token, &csrf).await;

    let req = json_with_token(
        "POST",
        &format!("/api/conversations/{id}/warmup"),
        json!(null),
        &token,
        &csrf,
    );
    let resp = app.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn runtime_ensure_recovers_missing_agent_and_returns_config_snapshot() {
    let (mut app, services) = build_app_with_mock_agents().await;
    let (token, csrf) = setup_and_login(&mut app, &services, "admin", "StrongP@ss1").await;
    let id = create_conversation(&mut app, &token, &csrf).await;

    let req = json_with_token(
        "POST",
        &format!("/api/conversations/{id}/runtime/ensure"),
        json!(null),
        &token,
        &csrf,
    );
    let resp = app.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["success"], true);
    assert_eq!(json["data"]["recovered"], true);
    assert_eq!(json["data"]["runtime"]["has_task"], true);
    assert_eq!(json["data"]["config_options"][0]["id"], "model");
    assert_eq!(json["data"]["config_options"][0]["current_value"], "mock-model");
}

#[tokio::test]
async fn runtime_ensure_uses_existing_agent_without_recovery() {
    let (mut app, services) = build_app_with_mock_agents().await;
    let (token, csrf) = setup_and_login(&mut app, &services, "admin", "StrongP@ss1").await;
    let id = create_and_ensure_runtime_conversation(&mut app, &token, &csrf).await;

    let req = json_with_token(
        "POST",
        &format!("/api/conversations/{id}/runtime/ensure"),
        json!(null),
        &token,
        &csrf,
    );
    let resp = app.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["data"]["recovered"], false);
    assert_eq!(json["data"]["runtime"]["has_task"], true);
    assert_eq!(json["data"]["config_options"][0]["id"], "model");
}

#[tokio::test]
async fn set_config_option_requires_csrf() {
    let (mut app, services) = build_app_with_mock_agents().await;
    let (token, csrf) = setup_and_login(&mut app, &services, "admin", "StrongP@ss1").await;
    let id = create_and_ensure_runtime_conversation(&mut app, &token, &csrf).await;

    let req = Request::builder()
        .method("PUT")
        .uri(format!("/api/conversations/{id}/config-options/model"))
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(
            serde_json::to_vec(&json!({ "value": "mock-model-updated" })).unwrap(),
        ))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
    let json = body_json(resp).await;
    assert_eq!(json["code"], "CSRF_INVALID");
}

#[tokio::test]
async fn set_config_option_returns_observed_confirmation() {
    let (mut app, services) = build_app_with_mock_agents().await;
    let (token, csrf) = setup_and_login(&mut app, &services, "admin", "StrongP@ss1").await;
    let id = create_and_ensure_runtime_conversation(&mut app, &token, &csrf).await;

    let req = json_with_token(
        "PUT",
        &format!("/api/conversations/{id}/config-options/model"),
        json!({ "value": "mock-model-updated" }),
        &token,
        &csrf,
    );
    let resp = app.oneshot(req).await.unwrap();

    assert_eq!(resp.status(), StatusCode::OK);
    let json = body_json(resp).await;
    assert_eq!(json["data"]["confirmation"], "observed");
    assert_eq!(json["data"]["config_options"][0]["current_value"], "mock-model-updated");
}

// NOTE (POUNDING): Upstream had two negative tests here —
// `legacy_config_options_get_route_is_removed` and
// `old_mode_and_model_routes_are_removed` — asserting that
// `GET /config-options`, `GET/PUT /mode`, and `GET/PUT /model` return 404.
// POUNDING deliberately KEEPS those dedicated CC-Switch routes (see
// `aionui-conversation/src/routes_aux.rs`), so upstream's assertions are the
// exact opposite of POUNDING's intended behavior. The tests were removed rather
// than kept-and-inverted. Do NOT re-add them during future upstream syncs.
