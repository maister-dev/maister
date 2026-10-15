#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/proc.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>

static int inspection_failure(int pgid, const char *stage, int error) {
  fprintf(stderr, "{\"event\":\"process-group-inspection-failed\",\"pgid\":%d,\"stage\":\"%s\",\"errno\":%d}\n", pgid, stage, error);
  return 70;
}

/* KERN_PROC_PGRP includes every UID, inspector and zombie; no environment is read. */
int main(int argc, char **argv) {
  if (argc != 2) return 64;
  char *end;
  long value = strtol(argv[1], &end, 10);
  if (*end || value <= 1 || value > 2147483647) return 64;
  int pgid = (int)value;
  int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PGRP, pgid};
  size_t length = 0;
  if (sysctl(mib, 4, NULL, &length, NULL, 0) != 0)
    return inspection_failure(pgid, "group_catalogue_size", errno);
  if (length > 16 * 1024 * 1024)
    return inspection_failure(pgid, "group_catalogue_budget", EOVERFLOW);
  size_t capacity = length + 16 * sizeof(struct kinfo_proc);
  struct kinfo_proc *members = malloc(capacity);
  if (!members) return inspection_failure(pgid, "group_catalogue_buffer", ENOMEM);
  length = capacity;
  if (sysctl(mib, 4, members, &length, NULL, 0) != 0) {
    int error = errno;
    free(members);
    return inspection_failure(pgid, "group_catalogue", error);
  }
  if (length >= capacity || length % sizeof(struct kinfo_proc) != 0) {
    free(members);
    return inspection_failure(pgid, "group_catalogue_incomplete", EOVERFLOW);
  }
  size_t count = length / sizeof(struct kinfo_proc), live = 0;
  for (size_t index = 0; index < count; index++) {
    if (members[index].kp_eproc.e_pgid != pgid || members[index].kp_proc.p_pid <= 0 ||
        members[index].kp_proc.p_stat <= 0 || members[index].kp_proc.p_stat > SZOMB) {
      free(members);
      return inspection_failure(pgid, "group_member_identity", EINVAL);
    }
    if (members[index].kp_proc.p_stat != SZOMB) live++;
  }
  printf("%d\t%zu\t%zu\n", pgid, count, live);
  free(members);
  return ferror(stdout) ? 74 : 0;
}
