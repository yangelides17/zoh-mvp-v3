/**
 * Best-guess time zone from a US number's area code. Static on purpose: it only has to be
 * good enough to note whether the tester may be outside Eastern (the city is asked at plan agreement).
 */

export type TimeZoneGuess = { timeZone: string; status: "assumed_eastern" | "needs_city" };

const EASTERN = "America/New_York";

/** Area codes wholly in Eastern Time. Codes split across zones are listed below instead. */
const EASTERN_CODES = codes(`
  203 475 860 959 302 202 771
  239 305 321 324 352 386 407 448 561 645 656 689 727 728 754 772 786 813 863 904 941 954
  229 404 470 478 678 706 762 770 912 943
  207 227 240 301 410 443 667 339 351 413 508 617 774 781 857 978
  231 248 269 313 517 586 616 679 734 810 947 989
  603 201 551 609 640 732 848 856 862 908 973
  212 315 329 332 347 363 516 518 585 607 624 631 646 680 716 718 838 845 914 917 929 934
  252 336 472 704 743 828 910 919 980 984
  216 220 234 283 326 330 380 419 436 440 513 567 614 740 937
  215 223 267 272 412 445 484 570 582 610 717 724 814 835 878
  401 803 839 843 854 864 802
  276 434 540 571 703 757 804 826 948 304 681
  260 317 463 765 930 502 859 606 423 865
`);

/** Everything else we recognize: the most likely zone. Split codes lean to where most people live. */
const OTHER_ZONES: Record<string, string> = {
  // Split with Eastern
  ...zone("America/New_York", "850 906 574 812"),
  ...zone("America/Chicago", "219 270 364"),
  // Central
  ...zone(
    "America/Chicago",
    `205 251 256 334 659 938 327 479 501 870
     217 224 309 312 331 447 464 618 630 708 730 773 779 815 847 861 872
     319 515 563 641 712 316 620 785 913 225 318 337 504 985
     218 320 507 612 651 763 952 228 601 662 769 314 417 557 573 636 660 816 975
     308 402 531 701 405 539 572 580 918 605
     210 214 254 281 325 346 361 409 430 432 469 512 682 713 726 737 806 817 830 832 903 936 940 945 956 972 979
     262 274 414 534 608 715 920 615 629 731 901 931`,
  ),
  // Mountain
  ...zone("America/Denver", "303 719 720 970 983 406 505 575 385 435 801 307 915"),
  ...zone("America/Boise", "208 986"),
  ...zone("America/Phoenix", "480 520 602 623 928"),
  // Pacific
  ...zone(
    "America/Los_Angeles",
    `209 213 279 310 323 341 350 369 408 415 424 442 510 530 559 562 619 626 628 650 657 661 669
     707 714 747 760 805 818 820 831 840 858 909 916 925 949 951
     702 725 775 458 503 541 971 206 253 360 425 509 564`,
  ),
  ...zone("America/Anchorage", "907"),
  ...zone("Pacific/Honolulu", "808"),
};

/** Eastern area codes are assumed Eastern; anything else is a best guess, possibly outside Eastern. */
export function guessTimeZone(phone: string): TimeZoneGuess {
  const code = /^\+1(\d{3})\d{7}$/.exec(phone)?.[1];
  if (code && EASTERN_CODES.has(code)) return { timeZone: EASTERN, status: "assumed_eastern" };
  return { timeZone: (code && OTHER_ZONES[code]) || EASTERN, status: "needs_city" };
}

function codes(list: string): Set<string> {
  return new Set(list.split(/\s+/).filter(Boolean));
}

function zone(timeZone: string, list: string): Record<string, string> {
  return Object.fromEntries([...codes(list)].map((c) => [c, timeZone]));
}
