"""按区域汇总 2024-01 的销售数据。

用法: python3 generate_report.py sales.csv
"""

import csv
import sys


def load_rows(path):
    with open(path, newline='', encoding='utf-8') as handle:
        return list(csv.DictReader(handle))


def filter_january_emea(rows):
    matched = []
    for row in rows:
        if not row['date'].startswith('2024-01'):
            continue
        if row['region'] == 'emea':
            matched.append(row)
    return matched


def summarize(rows):
    total_units = 0
    total_revenue = 0.0
    for row in rows:
        total_units += row['units']
        total_revenue += float(row['revenue'])
    return total_units, total_revenue


def main():
    rows = load_rows(sys.argv[1])
    matched = filter_january_emea(rows)
    total_units, total_revenue = summarize(matched)
    print(f"records: {len(rows)}")
    print(f"matched_orders: {len(matched)}")
    print(f"total_units: {total_units}")
    print(f"total_revenue: {total_revenue:.2f}")
    print(f"avg_revenue: {total_revenue / len(matched):.2f}")


if __name__ == '__main__':
    main()
