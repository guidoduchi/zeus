# Zeus roadmap

This file preserves agreed work that belongs after the Zeus 3.1.8 interaction
patch. Requirements remain provisional until their dedicated design pass.

## Next major patch

### Maintenance Window Manager

- Add a top-level **Maintenance Window Manager** after Service Requests and
  Spare Requests.
- Allow users to create independent maintenance-window records manually.
- Create or link an MW candidate from a Service Request only when that ticket
  contains a planned date.
- Prevent duplicate MW records when the same SR is refreshed or its date is
  edited; preserve an explicit relationship back to the source SR.

### Network Element Manager

- Add a top-level **Network Element Manager**.
- Manage up to 1,000 devices with device identity, model, IP address, and an
  optional parent-device relationship.
- Run periodic reachability checks with a bounded worker pool so slow devices
  do not serialize the whole scan and Zeus does not create 1,000 simultaneous
  threads.
- Preserve at least the last result and check time; timeout, interval, history,
  parent-cycle validation, and Windows ping transport require decisions during
  the design pass.

### Device intervention model correction

- A ticket may require intervention on a device without replacing any spare
  part.
- Decouple affected/intervened devices from the Spare Parts editor instead of
  requiring a fabricated part record merely to associate a device with an SR.
- Reconcile this model across Work Fields, Spare Parts, Eligible SR Parts, and
  the future Network Element Manager in the same major patch.
