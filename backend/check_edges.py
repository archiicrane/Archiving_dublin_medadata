import json

rc = json.load(open('data/processed/region_connections.json'))
print(f'Total region connections: {len(rc)}')

if rc:
    print('\n=== SAMPLE CONNECTION ===')
    print(json.dumps(rc[0], indent=2)[:500])

ig = json.load(open('data/processed/image_graph.json'))
print(f'\n=== EDGES ({len(ig["edges"])} total) ===')
for edge in ig['edges'][:3]:
    print(f"Edge: {edge['source']} -> {edge['target']}")
    print(f"  Types: {edge['connection_types']}")
    if 'content_aware_match' in edge['connection_types']:
        print(f"  ✓ Content-aware match detected!")
    print(f"  Explanation: {edge['explanation'][:150]}...")
    print()
