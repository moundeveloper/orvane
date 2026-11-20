# Custom Lists (`customlist`)

`scriptid` prefix: `customlist_`. One XML file in `src/Objects/`; deploy with `suitecloud project:deploy` (or MCP `objects:[{xml}]` if connected). Referenced by SELECT fields as `<selectrecordtype>[scriptid=customlist_x]</selectrecordtype>`.

## Structure

```xml
<customlist scriptid="customlist_acme_my_status">
  <name>My Status</name>
  <description></description>
  <isinactive>F</isinactive>
  <ismatrixoption>F</ismatrixoption>   <!-- T only for matrix-item option lists -->
  <isordered>T</isordered>              <!-- T = keep author order; F = alphabetical -->
  <customvalues>
    <customvalue scriptid="val_acme_in_progress">
      <value>IN_PROGRESS</value>
      <abbreviation>I</abbreviation>
      <isinactive>F</isinactive>
    </customvalue>
    <customvalue scriptid="val_acme_completed">
      <value>COMPLETED</value>
      <isinactive>F</isinactive>
    </customvalue>
  </customvalues>
</customlist>
```

See `examples/customlist_ordered.xml`.

## Gotchas

- Each `<customvalue scriptid="...">` must be unique. Imports generate machine ids like `val_63799_..._991`; when authoring new lists use readable ids (`val_acme_...`).
- **Do not delete a `customvalue` that is already referenced by saved data** — set `<isinactive>T` instead. Removing it from the XML on redeploy drops the option.
- `<value>` is the stored/displayed text; `<abbreviation>` optional short code.
- `isordered=T` preserves the XML order in dropdowns.
