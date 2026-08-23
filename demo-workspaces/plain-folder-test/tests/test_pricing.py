from src.pricing import calculate_order_total


def test_vip_order_gets_ten_percent_discount() -> None:
    assert calculate_order_total(200, True) == 180


def test_regular_order_keeps_original_price() -> None:
    assert calculate_order_total(200, False) == 200
