# Runtime-v1 contract producer reference

gsd-pi is a hash-checking consumer of the C01 interface contracts. It does not
own or fork the schema.

- Producer task: C01 (raid-night)
- Producer path: raid-night/docs/migration/pack/contracts/
- Pack version: 1.0.0
- Schema id: https://firsttracksmaterials.invalid/raidnight/runtime-control-v1.schema.json
- Schema SHA256: 0643f017003901c73859db55ae74dbc0bb67b270e43554a7111ca8038d8aca01

Files under this directory were copied verbatim from the C01 installed pack.
Consumer tests verify every manifest path digest. Do not edit schema, examples,
or fixtures to make implementation easier. Schema or fixture corrections belong
to C01 in raid-night.
