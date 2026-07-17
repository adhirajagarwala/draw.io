#include <stdio.h>
int main ()
{
    int A, B, C, D;
    printf ("Please enter three numbers: ");
    if (3 != scanf ("%d%d%d", &A, &B, &C)) {
        printf ("Invalid input.\n");   /* PART ONE */
	return 3;
    }
    if (A < B) {
        D = A;      /* PART TWO */
	A = B;
	B = D;
    }
    if (A < C) {
        D = A;      /* PART THREE */
	A = C;
	C = D;
    }
    if (B < C) {
        D = B;      /* PART FOUR */
	B = C;
	C = D;
    }

    /* PART FIVE */
    printf ("The numbers are %d, %d, and %d.\n",
            A, B, C);
    return 0;
}
