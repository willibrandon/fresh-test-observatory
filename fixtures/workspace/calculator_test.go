package fixture

import "testing"

func TestAdd(t *testing.T) {
	t.Run("positive", func(t *testing.T) {
		if actual := Add(2, 3); actual != 5 {
			t.Fatalf("Add(2, 3) = %d, want 5", actual)
		}
	})
}

func TestMultiply(t *testing.T) {
	if actual := Multiply(3, 4); actual != 12 {
		t.Fatalf("Multiply(3, 4) = %d, want 12", actual)
	}
}

func TestDeferredScenario(t *testing.T) {
	t.Skip("Used to verify skipped-state rendering")
}
