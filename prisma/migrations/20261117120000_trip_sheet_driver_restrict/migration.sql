-- Deleting a driver must not delete their live runs.
--
-- TripSheet -> Driver was ON DELETE CASCADE, so deleting a driver silently
-- deleted every trip sheet they still had, with its stops, signatures and
-- collections' trip links, and wrote no CompletedTripSheet archive. A trip
-- sheet exists only while its run is live (completion deletes it), so RESTRICT
-- refuses exactly the deletes that would lose a run. deleteDriver checks first
-- and answers 409; this is the guarantee when a deploy lands mid-delete.
--
-- Same columns and target as before (the composite [tenantId, id] FK from
-- 20260726120100_tenant_isolation); only the delete action changes.
ALTER TABLE "TripSheet" DROP CONSTRAINT "TripSheet_tenantId_driverId_fkey";

ALTER TABLE "TripSheet" ADD CONSTRAINT "TripSheet_tenantId_driverId_fkey"
  FOREIGN KEY ("tenantId", "driverId") REFERENCES "Driver"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE NO ACTION;
