use observatory_rust_sample::add;

#[test]
fn public_add_api_returns_sum() {
    assert_eq!(add(20, 22), 42);
}
