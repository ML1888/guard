def calculate_order_total(amount: float, is_vip: bool) -> float:
    """Return the payable amount for an order."""
    return amount  # Bug: the VIP discount is missing.
