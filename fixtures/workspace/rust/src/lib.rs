/// Adds two integers.
///
///     use observatory_rust_sample::add;
///     assert_eq!(add(2, 3), 5);
pub fn add(left: i32, right: i32) -> i32 {
    left + right
}

pub fn multiply(left: i32, right: i32) -> i32 {
    left * right
}

#[cfg(test)]
mod tests {
    use super::{add, multiply};

    #[test]
    fn add_two_positive_numbers_returns_sum() {
        assert_eq!(add(2, 3), 5);
    }

    #[test]
    fn failure_navigation_anchor() {
        // This separate case gives nearest and file-scoped runs a clear target.
        assert_eq!(multiply(3, 3), 9);
    }

    #[test]
    #[ignore = "Used to verify skipped-state rendering"]
    fn deferred_scenario_is_reported_as_skipped() {
        unreachable!();
    }
}
