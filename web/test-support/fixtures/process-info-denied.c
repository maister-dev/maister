#include <stdio.h>
#include <sys/prctl.h>
#include <unistd.h>

/* Real same-UID /proc inspection denial, without changing credentials. */
int main(void) {
  if (prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0) {
    perror("PR_SET_DUMPABLE");
    return 125;
  }
  printf("denied:%ld\n", (long)getpid());
  fflush(stdout);
  for (;;) pause();
}
