-- Restore the lifecycle invariant for package Flows trusted before the
-- trustPackageRevision transition enabled ready member Flows. The predicate is
-- deliberately narrower than launchability: it repairs only a current,
-- attached, graph-only, trusted, successfully prepared package revision.
UPDATE flows AS f
SET
  enablement_state = 'Enabled',
  updated_at = clock_timestamp()
FROM package_installs AS pi,
  flow_revisions AS fr
WHERE f.package_install_id = pi.id
  AND fr.id = f.enabled_revision_id
  AND f.enablement_state = 'Installed'
  AND f.trust_status = 'trusted'
  AND pi.trust_status = 'trusted'
  AND pi.package_status = 'Installed'
  AND fr.package_status = 'Installed'
  AND fr.setup_status IN ('done', 'not_required')
  AND fr.exec_trust = 'trusted'
  AND fr.flow_ref_id = f.flow_ref_id
  AND fr.resolved_revision = pi.resolved_revision
  AND fr.manifest ? 'nodes'
  AND NOT fr.manifest ? 'steps'
  AND EXISTS (
    SELECT 1
    FROM project_package_attachments AS ppa
    WHERE ppa.project_id = f.project_id
      AND ppa.package_install_id = f.package_install_id
  );
